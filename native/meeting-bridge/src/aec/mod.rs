//! Bounded acoustic-echo-cancellation coordination.
//!
//! This module owns *stream alignment and fail-safe policy*, not a model
//! runtime.  A qualified LocalVQE or WebRTC AEC3 binding implements
//! [`AecProcessor`] and is injected here by the selected native capture host.
//! Keeping that binding out of this crate until its source, model, licence,
//! checksum, and platform binary are audited prevents a Cargo feature from
//! silently downloading or enabling an unreviewed DSP dependency.
//!
//! The coordinator accepts independent microphone and render/system callbacks,
//! buffers them for a short bounded interval, and only processes a mic frame
//! when it has a timestamp-qualified render reference.  Any uncertainty,
//! model failure, route isolation, or source discontinuity passes the original
//! microphone PCM through.  It never suppresses a mic frame because playback
//! is active, so near-end speech and double-talk remain available to ASR.

use std::collections::VecDeque;

use crate::types::{
    AecEngine, AecFrameDisposition, AecFrameMetadata, AecHealth, AecReferenceTiming, AecState,
    AudioFrame, Channel,
};

#[cfg(feature = "aec-localvqe")]
pub mod localvqe;
#[cfg(feature = "aec-webrtc-aec3")]
pub mod webrtc_aec3;

/// The fixed capture contract used by the native bridge.
pub const AEC_SAMPLE_RATE_HZ: u32 = 16_000;
/// A 20 ms mono frame at [`AEC_SAMPLE_RATE_HZ`].
pub const AEC_SAMPLES_PER_FRAME: usize = 320;

/// The user-visible output route classification supplied by the selected
/// capture adapter.  Headset/isolated routes intentionally bypass AEC so a
/// model cannot add latency or damage clean near-end audio without a benefit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AecOutputRoute {
    Isolated,
    Speaker,
    Unknown,
}

/// Trusted render timing must be provided by the capture adapter after it has
/// established a common capture clock.  An intake-derived timestamp is useful
/// for diagnostics, but is not enough to authorize a model to modify mic PCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AecReferenceAlignment {
    /// `render_start_sample - mic_start_sample` on the shared bridge clock.
    pub render_offset_samples: i64,
    pub timing: AecReferenceTiming,
}

impl AecReferenceAlignment {
    pub const fn trusted(render_offset_samples: i64) -> Self {
        Self {
            render_offset_samples,
            timing: AecReferenceTiming::Trusted,
        }
    }

    /// A conservative default for an adapter that has not yet exposed a
    /// common timestamp clock.  It deliberately causes raw pass-through.
    pub const fn untrusted() -> Self {
        Self {
            render_offset_samples: 0,
            timing: AecReferenceTiming::Untrusted,
        }
    }
}

/// Bounded alignment and holdback configuration.  The defaults retain no more
/// than one second of render audio and 120 ms of microphone audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AecConfig {
    pub alignment: AecReferenceAlignment,
    pub maximum_reference_history_frames: usize,
    pub maximum_pending_mic_frames: usize,
    pub maximum_alignment_delta_samples: u32,
}

impl Default for AecConfig {
    fn default() -> Self {
        Self {
            alignment: AecReferenceAlignment::untrusted(),
            maximum_reference_history_frames: 50,
            maximum_pending_mic_frames: 6,
            maximum_alignment_delta_samples: AEC_SAMPLES_PER_FRAME as u32 / 2,
        }
    }
}

/// Privacy-safe counters for comparing LocalVQE, AEC3, and raw bypass on the
/// same physical corpus.  These counters do not measure ERLE or intelligibility
/// and must not be interpreted as an acoustic-quality claim.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AecMetrics {
    pub accepted_render_frames: u64,
    pub accepted_mic_frames: u64,
    pub cleaned_frames: u64,
    pub fallback_cleaned_frames: u64,
    pub raw_bypass_frames: u64,
    pub reference_missing_frames: u64,
    pub processor_failure_frames: u64,
    pub reference_evictions: u64,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum AecError {
    #[error("AEC requires 16 kHz mono 20 ms frames")]
    InvalidFrame,
    #[error("AEC configuration must retain at least one render and pending microphone frame")]
    InvalidConfiguration,
    #[error("AEC processor returned {actual} samples, expected at most {expected}")]
    InvalidOutput { actual: usize, expected: usize },
    #[error("AEC processor {engine:?} failed: {message}")]
    Processor { engine: AecEngine, message: String },
    #[error("no audited {engine:?} binding or model is available in this build")]
    BindingUnavailable { engine: AecEngine },
}

/// An implementation-specific streaming canceller. LocalVQE and AEC3 bindings
/// are deliberately adapters behind this trait: neither upstream API nor any
/// model binary is guessed or bundled by the bridge.
pub trait AecProcessor: Send {
    fn engine(&self) -> AecEngine;

    /// Accepts one 320-sample bridge frame and returns zero or more *ordered*
    /// cleaned samples.  A processor with a smaller native hop may defer its
    /// first complete bridge-frame result; the coordinator holds associated
    /// mic metadata until it has all 320 samples. It must never pad output,
    /// reorder samples, or emit more samples than it consumed.
    fn process(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError>;

    /// Source gaps invalidate adaptive state.  Reset must be bounded and may
    /// not allocate an unbounded history or persist audio.
    fn reset(&mut self);

    /// A comparator chain changes this after promoting its fallback.
    fn active_engine(&self) -> AecEngine {
        self.engine()
    }

    /// A comparator can override this to expose a per-frame fallback without
    /// leaking engine-internal diagnostics into bridge logs.
    fn used_fallback_for_last_frame(&self) -> bool {
        false
    }
}

/// A processor with a native fixed hop (LocalVQE: 256; WebRTC AEC3: 160).
/// [`StreamingReblocker`] converts bridge frames into those hops without
/// pretending that a 320-sample input is a native hop.
pub trait AecHopProcessor: Send {
    fn engine(&self) -> AecEngine;
    fn hop_samples(&self) -> usize;
    fn process_hop(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError>;
    fn reset(&mut self);
}

/// Exact-order, bounded bridge-frame to fixed-hop reblocker. Its short startup
/// delay is intentional: a 320-sample capture frame cannot be passed to a 256
/// or 160-sample DSP API as if it were a native frame. The coordinator waits
/// for complete 320-sample output frames and releases an incomplete stop tail
/// raw rather than emitting a mixed or fabricated frame.
pub struct StreamingReblocker<P> {
    processor: P,
    render_pending: VecDeque<i16>,
    mic_pending: VecDeque<i16>,
}

impl<P: AecHopProcessor> StreamingReblocker<P> {
    pub fn new(processor: P) -> Self {
        Self {
            processor,
            render_pending: VecDeque::new(),
            mic_pending: VecDeque::new(),
        }
    }

    pub fn pending_input_samples(&self) -> usize {
        self.mic_pending.len()
    }
}

impl<P: AecHopProcessor> AecProcessor for StreamingReblocker<P> {
    fn engine(&self) -> AecEngine {
        self.processor.engine()
    }

    fn process(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError> {
        if render_pcm_s16le.len() != mic_pcm_s16le.len()
            || render_pcm_s16le.len() != AEC_SAMPLES_PER_FRAME
        {
            return Err(AecError::InvalidFrame);
        }
        let hop_samples = self.processor.hop_samples();
        if hop_samples == 0 || hop_samples > AEC_SAMPLES_PER_FRAME {
            return Err(AecError::InvalidFrame);
        }
        self.render_pending.extend(render_pcm_s16le);
        self.mic_pending.extend(mic_pcm_s16le);

        let mut output = Vec::with_capacity(AEC_SAMPLES_PER_FRAME);
        while self.render_pending.len() >= hop_samples && self.mic_pending.len() >= hop_samples {
            let render_hop = self.render_pending.drain(..hop_samples).collect::<Vec<_>>();
            let mic_hop = self.mic_pending.drain(..hop_samples).collect::<Vec<_>>();
            let cleaned = self.processor.process_hop(&render_hop, &mic_hop)?;
            if cleaned.len() != hop_samples {
                return Err(AecError::InvalidOutput {
                    actual: cleaned.len(),
                    expected: hop_samples,
                });
            }
            output.extend(cleaned);
        }
        Ok(output)
    }

    fn reset(&mut self) {
        self.render_pending.clear();
        self.mic_pending.clear();
        self.processor.reset();
    }
}

/// Promotes an optional AEC3 fallback after a primary failure.  It never feeds
/// the same frame to a cold stateful fallback: the coordinator releases that
/// frame (and any buffered predecessor) raw, then the next aligned frame
/// primes the fallback. This prevents a 256/160-hop engine swap from mixing
/// samples across timelines.
pub struct AecProcessorChain {
    primary: Box<dyn AecProcessor>,
    fallback: Option<Box<dyn AecProcessor>>,
    active_engine: AecEngine,
    fallback_promoted: bool,
    used_fallback_for_last_frame: bool,
}

impl AecProcessorChain {
    pub fn new(primary: Box<dyn AecProcessor>, fallback: Option<Box<dyn AecProcessor>>) -> Self {
        let active_engine = primary.engine();
        Self {
            primary,
            fallback,
            active_engine,
            fallback_promoted: false,
            used_fallback_for_last_frame: false,
        }
    }
}

impl AecProcessor for AecProcessorChain {
    fn engine(&self) -> AecEngine {
        self.primary.engine()
    }

    fn process(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError> {
        self.used_fallback_for_last_frame = false;
        if self.fallback_promoted {
            let Some(fallback) = self.fallback.as_mut() else {
                return Err(AecError::BindingUnavailable {
                    engine: self.primary.engine(),
                });
            };
            let output = fallback.process(render_pcm_s16le, mic_pcm_s16le)?;
            self.active_engine = fallback.active_engine();
            self.used_fallback_for_last_frame = true;
            return Ok(output);
        }
        match self.primary.process(render_pcm_s16le, mic_pcm_s16le) {
            Ok(output) => {
                self.active_engine = self.primary.active_engine();
                Ok(output)
            }
            Err(primary_error) => {
                let Some(fallback) = self.fallback.as_mut() else {
                    return Err(primary_error);
                };
                // Both engines can have stateful 256/160-hop reblockers. A
                // primary failure may happen after it buffered a prefix of
                // this 320-sample frame, so feeding the current frame to a
                // cold fallback would mix timelines. Fail open for this frame;
                // reset and promote the fallback for the next aligned frame.
                self.primary.reset();
                fallback.reset();
                self.active_engine = fallback.engine();
                self.fallback_promoted = true;
                Err(primary_error)
            }
        }
    }

    fn reset(&mut self) {
        self.primary.reset();
        if let Some(fallback) = self.fallback.as_mut() {
            fallback.reset();
        }
        self.active_engine = if self.fallback_promoted {
            self.fallback
                .as_ref()
                .map_or_else(|| self.primary.engine(), |fallback| fallback.engine())
        } else {
            self.primary.engine()
        };
        self.used_fallback_for_last_frame = false;
    }

    fn active_engine(&self) -> AecEngine {
        self.active_engine
    }

    fn used_fallback_for_last_frame(&self) -> bool {
        self.used_fallback_for_last_frame
    }
}

#[derive(Debug, Clone)]
struct RenderReference {
    start_sample: u64,
    pcm_s16le: Vec<i16>,
}

#[derive(Debug)]
struct PendingCleanedFrame {
    raw_frame: AudioFrame,
    engine: AecEngine,
    reference_offset_samples: i64,
    used_fallback: bool,
}

/// A small, in-memory processor coordinator.  It has no filesystem, model,
/// network, ASR, or renderer-facing PCM responsibility.
pub struct AecCoordinator {
    config: AecConfig,
    output_route: AecOutputRoute,
    processor: Option<Box<dyn AecProcessor>>,
    render_history: VecDeque<RenderReference>,
    /// Mic frames awaiting a timestamp-qualified render reference.
    pending_mic: VecDeque<AudioFrame>,
    /// Mic frames accepted by the processor but still waiting for a complete
    /// 320-sample cleaned output. This is what makes 320↔256/160 reblocking
    /// explicit instead of padding or claiming same-frame output.
    pending_cleaned: VecDeque<PendingCleanedFrame>,
    cleaned_pending_samples: VecDeque<i16>,
    reference_requires_reprime: bool,
    health: AecHealth,
    metrics: AecMetrics,
    health_changed: bool,
}

impl AecCoordinator {
    /// Construct the active LocalVQE-or-AEC3 path.  The caller supplies the
    /// audited processor, so selecting a model is explicit and reviewable.
    pub fn with_processor(
        meeting_id: impl Into<String>,
        config: AecConfig,
        output_route: AecOutputRoute,
        processor: Box<dyn AecProcessor>,
    ) -> Result<Self, AecError> {
        if config.maximum_reference_history_frames == 0 || config.maximum_pending_mic_frames == 0 {
            return Err(AecError::InvalidConfiguration);
        }
        let meeting_id = meeting_id.into();
        let engine = processor.engine();
        let mut health = AecHealth::new(meeting_id, Some(engine));
        health.state = match output_route {
            AecOutputRoute::Isolated => AecState::Bypassed,
            AecOutputRoute::Speaker | AecOutputRoute::Unknown => AecState::WaitingForReference,
        };
        Ok(Self {
            config,
            output_route,
            processor: Some(processor),
            render_history: VecDeque::new(),
            pending_mic: VecDeque::new(),
            pending_cleaned: VecDeque::new(),
            cleaned_pending_samples: VecDeque::new(),
            reference_requires_reprime: false,
            health,
            metrics: AecMetrics::default(),
            health_changed: true,
        })
    }

    /// Construct a raw-capture path which still stamps metadata.  This is the
    /// default until an audited processor is injected.
    pub fn disabled(meeting_id: impl Into<String>, output_route: AecOutputRoute) -> Self {
        let mut health = AecHealth::new(meeting_id, None);
        health.state = AecState::Bypassed;
        health.reason = Some("AEC is not selected".into());
        Self {
            config: AecConfig::default(),
            output_route,
            processor: None,
            render_history: VecDeque::new(),
            pending_mic: VecDeque::new(),
            pending_cleaned: VecDeque::new(),
            cleaned_pending_samples: VecDeque::new(),
            reference_requires_reprime: false,
            health,
            metrics: AecMetrics::default(),
            health_changed: true,
        }
    }

    pub fn health(&self) -> &AecHealth {
        &self.health
    }

    pub fn metrics(&self) -> &AecMetrics {
        &self.metrics
    }

    /// Returns changed health once, so a caller can project it as a bounded
    /// control event without emitting it per frame.
    pub fn take_health_update(&mut self) -> Option<AecHealth> {
        self.health_changed.then(|| {
            self.health_changed = false;
            self.health.clone()
        })
    }

    /// Updates route classification at a device change.  Moving to an isolated
    /// route drops the short in-memory histories and returns subsequent mic
    /// frames raw immediately.
    pub fn set_output_route(&mut self, output_route: AecOutputRoute) -> Vec<AudioFrame> {
        if self.output_route == output_route {
            return Vec::new();
        }
        let released = self.flush();
        self.output_route = output_route;
        self.reset_alignment();
        match output_route {
            AecOutputRoute::Isolated => {
                self.set_health(AecState::Bypassed, Some("isolated output route"))
            }
            AecOutputRoute::Speaker | AecOutputRoute::Unknown => {
                self.set_health(
                    AecState::WaitingForReference,
                    Some("output route changed; waiting for reference"),
                );
            }
        }
        released
    }

    /// Adds one system/render frame and releases any microphone frames whose
    /// reference has arrived.  The system frame itself remains untouched for
    /// the normal remote-ASR transport.
    pub fn push_render(&mut self, frame: AudioFrame) -> Result<Vec<AudioFrame>, AecError> {
        validate_frame(&frame, Channel::System)?;
        self.metrics.accepted_render_frames = self.metrics.accepted_render_frames.saturating_add(1);
        let mut output = Vec::new();

        if self.processor.is_none() || self.output_route == AecOutputRoute::Isolated {
            return Ok(self.drain_pending());
        }

        if frame.flags.discontinuity {
            output.extend(self.flush());
            self.reset_alignment();
            self.reference_requires_reprime = true;
            self.set_health(
                AecState::WaitingForReference,
                Some("render source discontinuity; waiting for a new reference"),
            );
        }

        if self.reference_requires_reprime {
            // The discontinuous frame establishes a new baseline, but a second
            // consecutive callback is required before it can modify mic PCM.
            self.reference_requires_reprime = false;
        } else {
            self.insert_render(frame);
        }
        output.extend(self.drain_pending());
        Ok(output)
    }

    /// Adds one microphone frame.  If a suitable render reference has not
    /// arrived, the mic is held only for the configured bounded window.  Once
    /// that window is exhausted it is released raw, preserving speech order.
    pub fn push_mic(&mut self, frame: AudioFrame) -> Result<Vec<AudioFrame>, AecError> {
        validate_frame(&frame, Channel::Mic)?;
        self.metrics.accepted_mic_frames = self.metrics.accepted_mic_frames.saturating_add(1);

        if frame.flags.discontinuity {
            let mut output = self.flush();
            self.reset_alignment();
            output.push(self.pass_through(
                frame,
                AecFrameDisposition::BypassedDiscontinuity,
                AecReferenceTiming::Missing,
                None,
            ));
            return Ok(output);
        }

        match (self.processor.is_some(), self.output_route) {
            (false, _) => Ok(vec![self.pass_through(
                frame,
                AecFrameDisposition::BypassedDisabled,
                AecReferenceTiming::NotUsed,
                None,
            )]),
            (true, AecOutputRoute::Isolated) => Ok(vec![self.pass_through(
                frame,
                AecFrameDisposition::BypassedIsolatedOutput,
                AecReferenceTiming::NotUsed,
                None,
            )]),
            (true, AecOutputRoute::Unknown) => Ok(vec![self.pass_through(
                frame,
                AecFrameDisposition::BypassedReferenceUnavailable,
                AecReferenceTiming::Untrusted,
                None,
            )]),
            (true, AecOutputRoute::Speaker) => {
                self.pending_mic.push_back(frame);
                self.sync_pending_health();
                Ok(self.drain_pending())
            }
        }
    }

    /// Releases all held mic frames raw during stop/restart.  AEC can never
    /// create a capture tail or discard an otherwise valid microphone frame.
    pub fn flush(&mut self) -> Vec<AudioFrame> {
        let mut held = Vec::with_capacity(self.pending_mic.len() + self.pending_cleaned.len());
        while let Some(frame) = self.pending_mic.pop_front() {
            held.push(frame);
        }
        while let Some(pending) = self.pending_cleaned.pop_front() {
            held.push(pending.raw_frame);
        }
        // Source frames share a single microphone clock.  Sorting makes an
        // AEC stop deterministic even when a late render reference left one
        // frame in each bounded queue.
        held.sort_by_key(|frame| (frame.epoch, frame.start_sample, frame.sequence));
        self.cleaned_pending_samples.clear();
        if let Some(processor) = self.processor.as_mut() {
            processor.reset();
        }
        let mut output = Vec::with_capacity(held.len());
        for frame in held {
            output.push(self.pass_through(
                frame,
                AecFrameDisposition::BypassedReferenceUnavailable,
                AecReferenceTiming::Missing,
                None,
            ));
        }
        self.sync_pending_health();
        output
    }

    fn insert_render(&mut self, frame: AudioFrame) {
        let reference = RenderReference {
            start_sample: frame.start_sample,
            pcm_s16le: frame.pcm_s16le,
        };
        if let Some(existing_index) = self
            .render_history
            .iter()
            .position(|existing| existing.start_sample == reference.start_sample)
        {
            self.render_history[existing_index] = reference;
            return;
        }
        let insertion_index = self
            .render_history
            .iter()
            .position(|existing| existing.start_sample > reference.start_sample)
            .unwrap_or(self.render_history.len());
        self.render_history.insert(insertion_index, reference);
        if self.render_history.len() > self.config.maximum_reference_history_frames {
            let _ = self.render_history.pop_front();
            self.metrics.reference_evictions = self.metrics.reference_evictions.saturating_add(1);
            self.health.reference_evictions = self.metrics.reference_evictions;
            self.health_changed = true;
        }
    }

    fn drain_pending(&mut self) -> Vec<AudioFrame> {
        let mut output = Vec::new();
        while let Some(frame) = self.pending_mic.front().cloned() {
            if self.processor.is_none() {
                let _ = self.pending_mic.pop_front();
                output.push(self.pass_through(
                    frame,
                    AecFrameDisposition::BypassedDisabled,
                    AecReferenceTiming::NotUsed,
                    None,
                ));
                continue;
            }
            if self.output_route == AecOutputRoute::Isolated {
                let _ = self.pending_mic.pop_front();
                output.push(self.pass_through(
                    frame,
                    AecFrameDisposition::BypassedIsolatedOutput,
                    AecReferenceTiming::NotUsed,
                    None,
                ));
                continue;
            }
            if self.config.alignment.timing != AecReferenceTiming::Trusted {
                let _ = self.pending_mic.pop_front();
                output.push(self.pass_through(
                    frame,
                    AecFrameDisposition::BypassedReferenceUnavailable,
                    self.config.alignment.timing,
                    None,
                ));
                continue;
            }

            if let Some((reference_index, offset)) = self.find_reference(&frame) {
                let reference = self
                    .render_history
                    .get(reference_index)
                    .expect("reference index came from this deque")
                    .clone();
                let _ = self.pending_mic.pop_front();
                output.extend(self.process_with_reference(frame, reference, offset));
                continue;
            }

            if self.reference_is_too_late(&frame)
                || self.pending_mic.len() > self.config.maximum_pending_mic_frames
            {
                let _ = self.pending_mic.pop_front();
                output.push(self.pass_through(
                    frame,
                    AecFrameDisposition::BypassedReferenceUnavailable,
                    AecReferenceTiming::Missing,
                    None,
                ));
                continue;
            }
            break;
        }
        self.sync_pending_health();
        output
    }

    fn find_reference(&self, mic: &AudioFrame) -> Option<(usize, i64)> {
        let target = shifted_sample(
            mic.start_sample,
            self.config.alignment.render_offset_samples,
        )?;
        self.render_history
            .iter()
            .enumerate()
            .filter_map(|(index, reference)| {
                let delta = signed_delta(reference.start_sample, target)?;
                (delta.unsigned_abs() <= u64::from(self.config.maximum_alignment_delta_samples))
                    .then_some((index, delta))
            })
            .min_by_key(|(_, delta)| delta.unsigned_abs())
    }

    fn reference_is_too_late(&self, mic: &AudioFrame) -> bool {
        let Some(target) = shifted_sample(
            mic.start_sample,
            self.config.alignment.render_offset_samples,
        ) else {
            return true;
        };
        let Some(latest) = self.render_history.back() else {
            return false;
        };
        latest.start_sample
            > target.saturating_add(u64::from(self.config.maximum_alignment_delta_samples))
    }

    fn process_with_reference(
        &mut self,
        mic: AudioFrame,
        reference: RenderReference,
        reference_offset_samples: i64,
    ) -> Vec<AudioFrame> {
        let Some(processor) = self.processor.as_mut() else {
            return vec![self.pass_through(
                mic,
                AecFrameDisposition::BypassedDisabled,
                AecReferenceTiming::NotUsed,
                None,
            )];
        };
        match processor.process(&reference.pcm_s16le, &mic.pcm_s16le) {
            Ok(cleaned) if cleaned.len() <= mic.pcm_s16le.len() => {
                let active_engine = processor.active_engine();
                let used_fallback = processor.used_fallback_for_last_frame();
                self.cleaned_pending_samples.extend(cleaned);
                self.pending_cleaned.push_back(PendingCleanedFrame {
                    raw_frame: mic,
                    engine: active_engine,
                    reference_offset_samples,
                    used_fallback,
                });
                if self.pending_cleaned.len() > self.config.maximum_pending_mic_frames {
                    return self
                        .release_processed_raw("AEC processor did not produce a complete frame");
                }
                self.emit_complete_cleaned()
            }
            Ok(cleaned) => self.on_processor_failure(
                mic,
                AecError::InvalidOutput {
                    actual: cleaned.len(),
                    expected: AEC_SAMPLES_PER_FRAME,
                },
            ),
            Err(error) => self.on_processor_failure(mic, error),
        }
    }

    fn emit_complete_cleaned(&mut self) -> Vec<AudioFrame> {
        let mut output = Vec::new();
        while self.cleaned_pending_samples.len() >= AEC_SAMPLES_PER_FRAME {
            let Some(mut pending) = self.pending_cleaned.pop_front() else {
                // A processor may never produce unowned audio. Clear it rather
                // than leaking stale samples into a later mic frame.
                self.cleaned_pending_samples.clear();
                self.set_health(AecState::Degraded, Some("AEC emitted unowned samples"));
                break;
            };
            pending.raw_frame.pcm_s16le = self
                .cleaned_pending_samples
                .drain(..AEC_SAMPLES_PER_FRAME)
                .collect();
            pending.raw_frame.aec = Some(AecFrameMetadata {
                engine: Some(pending.engine),
                disposition: AecFrameDisposition::Cleaned,
                reference_timing: AecReferenceTiming::Trusted,
                reference_offset_samples: Some(pending.reference_offset_samples),
            });
            self.metrics.cleaned_frames = self.metrics.cleaned_frames.saturating_add(1);
            if pending.used_fallback {
                self.metrics.fallback_cleaned_frames =
                    self.metrics.fallback_cleaned_frames.saturating_add(1);
            }
            self.health.engine = Some(pending.engine);
            self.health.processed_frames = self.metrics.cleaned_frames;
            self.set_health(AecState::Ready, None);
            output.push(pending.raw_frame);
        }
        output
    }

    fn release_processed_raw(&mut self, reason: &str) -> Vec<AudioFrame> {
        self.cleaned_pending_samples.clear();
        let mut output = Vec::with_capacity(self.pending_cleaned.len());
        while let Some(pending) = self.pending_cleaned.pop_front() {
            output.push(self.pass_through(
                pending.raw_frame,
                AecFrameDisposition::BypassedProcessorFailure,
                AecReferenceTiming::Trusted,
                None,
            ));
        }
        if let Some(processor) = self.processor.as_mut() {
            processor.reset();
        }
        self.set_health(AecState::Degraded, Some(reason));
        output
    }

    fn on_processor_failure(&mut self, mic: AudioFrame, error: AecError) -> Vec<AudioFrame> {
        self.metrics.processor_failure_frames =
            self.metrics.processor_failure_frames.saturating_add(1);
        self.health.processor_failure_frames = self.metrics.processor_failure_frames;
        self.set_health(
            AecState::Degraded,
            Some("AEC processor failed; raw microphone pass-through"),
        );
        let _ = error; // Detailed processor errors may contain backend data; do not project them.
        let mut output =
            self.release_processed_raw("AEC processor failed; raw microphone pass-through");
        output.push(self.pass_through(
            mic,
            AecFrameDisposition::BypassedProcessorFailure,
            AecReferenceTiming::Trusted,
            None,
        ));
        output
    }

    fn pass_through(
        &mut self,
        mut frame: AudioFrame,
        disposition: AecFrameDisposition,
        reference_timing: AecReferenceTiming,
        reference_offset_samples: Option<i64>,
    ) -> AudioFrame {
        frame.aec = Some(AecFrameMetadata {
            engine: self
                .processor
                .as_ref()
                .map(|processor| processor.active_engine()),
            disposition,
            reference_timing,
            reference_offset_samples,
        });
        self.metrics.raw_bypass_frames = self.metrics.raw_bypass_frames.saturating_add(1);
        self.health.raw_bypass_frames = self.metrics.raw_bypass_frames;
        if matches!(
            disposition,
            AecFrameDisposition::BypassedReferenceUnavailable
                | AecFrameDisposition::BypassedDiscontinuity
        ) {
            self.metrics.reference_missing_frames =
                self.metrics.reference_missing_frames.saturating_add(1);
            self.health.reference_missing_frames = self.metrics.reference_missing_frames;
            self.set_health(
                AecState::WaitingForReference,
                Some("timestamp-qualified render reference unavailable"),
            );
        }
        self.health_changed = true;
        frame
    }

    fn reset_alignment(&mut self) {
        self.render_history.clear();
        self.reference_requires_reprime = false;
        if let Some(processor) = self.processor.as_mut() {
            processor.reset();
        }
    }

    fn sync_pending_health(&mut self) {
        let pending = self.pending_mic.len() + self.pending_cleaned.len();
        if self.health.pending_mic_frames != pending {
            self.health.pending_mic_frames = pending;
            self.health_changed = true;
        }
    }

    fn set_health(&mut self, state: AecState, reason: Option<&str>) {
        let reason = reason.map(str::to_owned);
        if self.health.state != state || self.health.reason != reason {
            self.health.state = state;
            self.health.reason = reason;
            self.health_changed = true;
        }
    }
}

fn validate_frame(frame: &AudioFrame, channel: Channel) -> Result<(), AecError> {
    (frame.channel == channel
        && frame.sample_rate == AEC_SAMPLE_RATE_HZ
        && frame.sample_count as usize == AEC_SAMPLES_PER_FRAME
        && frame.pcm_s16le.len() == AEC_SAMPLES_PER_FRAME)
        .then_some(())
        .ok_or(AecError::InvalidFrame)
}

fn shifted_sample(sample: u64, offset: i64) -> Option<u64> {
    if offset.is_negative() {
        sample.checked_sub(offset.unsigned_abs())
    } else {
        sample.checked_add(offset as u64)
    }
}

fn signed_delta(left: u64, right: u64) -> Option<i64> {
    let difference = i128::from(left) - i128::from(right);
    i64::try_from(difference).ok()
}

#[cfg(test)]
mod tests {
    use crate::types::{AudioFrame, FrameFlags};

    use super::{
        AecConfig, AecCoordinator, AecEngine, AecFrameDisposition, AecHopProcessor, AecOutputRoute,
        AecProcessor, AecProcessorChain, AecReferenceAlignment, AecState, Channel,
        StreamingReblocker,
    };

    #[derive(Debug)]
    struct RecordingProcessor {
        engine: AecEngine,
        calls: usize,
        fail: bool,
    }

    impl RecordingProcessor {
        fn new(engine: AecEngine) -> Self {
            Self {
                engine,
                calls: 0,
                fail: false,
            }
        }
    }

    impl AecProcessor for RecordingProcessor {
        fn engine(&self) -> AecEngine {
            self.engine
        }

        fn process(&mut self, _: &[i16], mic: &[i16]) -> Result<Vec<i16>, super::AecError> {
            self.calls += 1;
            if self.fail {
                return Err(super::AecError::Processor {
                    engine: self.engine,
                    message: "test failure".into(),
                });
            }
            // A deterministic test processor; it intentionally makes no
            // acoustic-quality claim and preserves all near-end samples.
            Ok(mic.to_vec())
        }

        fn reset(&mut self) {}
    }

    #[derive(Debug)]
    struct IdentityHopProcessor;

    impl AecHopProcessor for IdentityHopProcessor {
        fn engine(&self) -> AecEngine {
            AecEngine::LocalVqe
        }

        fn hop_samples(&self) -> usize {
            256
        }

        fn process_hop(&mut self, _: &[i16], mic: &[i16]) -> Result<Vec<i16>, super::AecError> {
            Ok(mic.to_vec())
        }

        fn reset(&mut self) {}
    }

    #[derive(Debug, Default)]
    struct PartialThenFailProcessor {
        calls: usize,
    }

    impl AecProcessor for PartialThenFailProcessor {
        fn engine(&self) -> AecEngine {
            AecEngine::LocalVqe
        }

        fn process(&mut self, _: &[i16], mic: &[i16]) -> Result<Vec<i16>, super::AecError> {
            self.calls += 1;
            if self.calls == 1 {
                return Ok(mic[..256].to_vec());
            }
            Err(super::AecError::Processor {
                engine: AecEngine::LocalVqe,
                message: "test stateful primary failure".into(),
            })
        }

        fn reset(&mut self) {}
    }

    fn frame(channel: Channel, start_sample: u64, value: i16) -> AudioFrame {
        AudioFrame {
            meeting_id: "meeting".into(),
            source_id: "source".into(),
            channel,
            start_sample,
            sample_count: 320,
            sample_rate: 16_000,
            sequence: start_sample / 320,
            epoch: 0,
            flags: FrameFlags::default(),
            aec: None,
            pcm_s16le: vec![value; 320],
        }
    }

    fn config() -> AecConfig {
        AecConfig {
            alignment: AecReferenceAlignment::trusted(0),
            maximum_reference_history_frames: 3,
            maximum_pending_mic_frames: 2,
            maximum_alignment_delta_samples: 0,
        }
    }

    fn active() -> AecCoordinator {
        AecCoordinator::with_processor(
            "meeting",
            config(),
            AecOutputRoute::Speaker,
            Box::new(RecordingProcessor::new(AecEngine::LocalVqe)),
        )
        .expect("valid AEC coordinator")
    }

    #[test]
    fn waits_for_a_bounded_timestamp_aligned_render_reference() {
        let mut coordinator = active();
        assert!(coordinator
            .push_mic(frame(Channel::Mic, 0, 42))
            .expect("mic")
            .is_empty());

        let output = coordinator
            .push_render(frame(Channel::System, 0, 7))
            .expect("render");
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].pcm_s16le, vec![42; 320]);
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::Cleaned
        );
        assert_eq!(coordinator.health().state, AecState::Ready);
    }

    #[test]
    fn preserves_double_talk_instead_of_suppressing_the_microphone() {
        let mut coordinator = active();
        let _ = coordinator
            .push_render(frame(Channel::System, 320, 100))
            .expect("render");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 320, -200))
            .expect("mic");
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].pcm_s16le, vec![-200; 320]);
        assert_eq!(coordinator.metrics().cleaned_frames, 1);
    }

    #[test]
    fn missing_reference_releases_raw_mic_after_bounded_holdback() {
        let mut coordinator = active();
        assert!(coordinator
            .push_mic(frame(Channel::Mic, 0, 1))
            .expect("mic")
            .is_empty());
        assert!(coordinator
            .push_mic(frame(Channel::Mic, 320, 2))
            .expect("mic")
            .is_empty());
        let output = coordinator
            .push_mic(frame(Channel::Mic, 640, 3))
            .expect("mic");
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].pcm_s16le, vec![1; 320]);
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::BypassedReferenceUnavailable
        );
        assert_eq!(coordinator.health().state, AecState::WaitingForReference);
    }

    #[test]
    fn isolated_output_bypasses_without_waiting_or_loading_reference_state() {
        let mut coordinator = AecCoordinator::with_processor(
            "meeting",
            config(),
            AecOutputRoute::Isolated,
            Box::new(RecordingProcessor::new(AecEngine::LocalVqe)),
        )
        .expect("coordinator");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 0, 8))
            .expect("mic");
        assert_eq!(output.len(), 1);
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::BypassedIsolatedOutput
        );
        assert_eq!(coordinator.metrics().cleaned_frames, 0);
    }

    #[test]
    fn untrusted_timestamps_fail_open_without_modifying_mic() {
        let mut unsafe_config = config();
        unsafe_config.alignment = AecReferenceAlignment::untrusted();
        let mut coordinator = AecCoordinator::with_processor(
            "meeting",
            unsafe_config,
            AecOutputRoute::Speaker,
            Box::new(RecordingProcessor::new(AecEngine::LocalVqe)),
        )
        .expect("coordinator");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 0, 91))
            .expect("mic");
        assert_eq!(output[0].pcm_s16le, vec![91; 320]);
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").reference_timing,
            crate::types::AecReferenceTiming::Untrusted
        );
    }

    #[test]
    fn source_discontinuity_resets_alignment_and_passes_raw_mic() {
        let mut coordinator = active();
        let _ = coordinator
            .push_render(frame(Channel::System, 0, 3))
            .expect("render");
        let mut mic = frame(Channel::Mic, 0, 4);
        mic.flags.discontinuity = true;
        let output = coordinator.push_mic(mic).expect("mic");
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::BypassedDiscontinuity
        );
        assert_eq!(coordinator.health().state, AecState::WaitingForReference);
    }

    #[test]
    fn aec3_comparator_promotes_only_after_failing_frame_passes_raw() {
        let mut primary = RecordingProcessor::new(AecEngine::LocalVqe);
        primary.fail = true;
        let chain = AecProcessorChain::new(
            Box::new(primary),
            Some(Box::new(RecordingProcessor::new(AecEngine::WebRtcAec3))),
        );
        let mut coordinator = AecCoordinator::with_processor(
            "meeting",
            config(),
            AecOutputRoute::Speaker,
            Box::new(chain),
        )
        .expect("coordinator");
        let _ = coordinator
            .push_render(frame(Channel::System, 0, 3))
            .expect("render");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 0, 9))
            .expect("mic");
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::BypassedProcessorFailure
        );
        let _ = coordinator
            .push_render(frame(Channel::System, 320, 3))
            .expect("render");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 320, 9))
            .expect("mic");
        assert_eq!(
            output[0].aec.as_ref().expect("metadata").engine,
            Some(AecEngine::WebRtcAec3)
        );
        assert_eq!(coordinator.metrics().cleaned_frames, 1);
    }

    #[test]
    fn stateful_primary_failure_releases_partial_history_raw_before_aec3_promotion() {
        let mut delayed_config = config();
        delayed_config.maximum_pending_mic_frames = 4;
        let chain = AecProcessorChain::new(
            Box::new(PartialThenFailProcessor::default()),
            Some(Box::new(RecordingProcessor::new(AecEngine::WebRtcAec3))),
        );
        let mut coordinator = AecCoordinator::with_processor(
            "meeting",
            delayed_config,
            AecOutputRoute::Speaker,
            Box::new(chain),
        )
        .expect("coordinator");

        let _ = coordinator
            .push_render(frame(Channel::System, 0, 3))
            .expect("render");
        assert!(coordinator
            .push_mic(frame(Channel::Mic, 0, 1))
            .expect("mic")
            .is_empty());
        let _ = coordinator
            .push_render(frame(Channel::System, 320, 3))
            .expect("render");
        let failed = coordinator
            .push_mic(frame(Channel::Mic, 320, 2))
            .expect("mic");
        assert_eq!(
            failed.len(),
            2,
            "partial primary output is not mixed into a fallback frame"
        );
        assert_eq!(failed[0].start_sample, 0);
        assert_eq!(failed[0].pcm_s16le, vec![1; 320]);
        assert_eq!(failed[1].start_sample, 320);
        assert_eq!(failed[1].pcm_s16le, vec![2; 320]);
        assert!(failed.iter().all(|frame| {
            frame
                .aec
                .as_ref()
                .is_some_and(|aec| aec.disposition == AecFrameDisposition::BypassedProcessorFailure)
        }));

        let _ = coordinator
            .push_render(frame(Channel::System, 640, 3))
            .expect("render");
        let promoted = coordinator
            .push_mic(frame(Channel::Mic, 640, 4))
            .expect("mic");
        assert_eq!(
            promoted[0].aec.as_ref().expect("metadata").engine,
            Some(AecEngine::WebRtcAec3)
        );
    }

    #[test]
    fn streaming_reblocker_preserves_sample_order_across_320_to_256_hops() {
        let mut reblocker = StreamingReblocker::new(IdentityHopProcessor);
        let first = (0_i16..320).collect::<Vec<_>>();
        let second = (320_i16..640).collect::<Vec<_>>();
        let first_output = reblocker
            .process(&first, &first)
            .expect("first bridge frame");
        let second_output = reblocker
            .process(&second, &second)
            .expect("second bridge frame");

        assert_eq!(first_output.len(), 256);
        assert_eq!(second_output.len(), 256);
        assert_eq!(
            first_output
                .into_iter()
                .chain(second_output)
                .collect::<Vec<_>>(),
            (0_i16..512).collect::<Vec<_>>()
        );
        assert_eq!(reblocker.pending_input_samples(), 128);
    }

    #[test]
    fn reblocked_processor_emits_only_whole_delayed_bridge_frames_and_flushes_tail_raw() {
        let mut delayed_config = config();
        delayed_config.maximum_pending_mic_frames = 4;
        let processor = StreamingReblocker::new(IdentityHopProcessor);
        let mut coordinator = AecCoordinator::with_processor(
            "meeting",
            delayed_config,
            AecOutputRoute::Speaker,
            Box::new(processor),
        )
        .expect("coordinator");

        let _ = coordinator
            .push_render(frame(Channel::System, 0, 10))
            .expect("render");
        assert!(coordinator
            .push_mic(frame(Channel::Mic, 0, 1))
            .expect("mic")
            .is_empty());
        let _ = coordinator
            .push_render(frame(Channel::System, 320, 10))
            .expect("render");
        let output = coordinator
            .push_mic(frame(Channel::Mic, 320, 2))
            .expect("mic");
        assert_eq!(output.len(), 1, "one full 320-sample output frame is ready");
        assert_eq!(output[0].start_sample, 0);
        assert_eq!(output[0].pcm_s16le, vec![1; 320]);

        let tail = coordinator.flush();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].start_sample, 320);
        assert_eq!(tail[0].pcm_s16le, vec![2; 320]);
        assert_eq!(
            tail[0].aec.as_ref().expect("metadata").disposition,
            AecFrameDisposition::BypassedReferenceUnavailable
        );
    }

    #[test]
    fn flush_never_drops_held_microphone_audio() {
        let mut coordinator = active();
        let _ = coordinator
            .push_mic(frame(Channel::Mic, 0, 11))
            .expect("mic");
        let output = coordinator.flush();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].pcm_s16le, vec![11; 320]);
    }
}
