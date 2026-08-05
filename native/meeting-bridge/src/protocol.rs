//! Newline-delimited JSON control/events for Electron main <-> bridge.
//!
//! The renderer must only receive projected structured events from Electron
//! main. The one exception is the opt-in `aec_process` request: Electron main
//! sends exactly one paired 20 ms frame to the supervised helper and receives
//! the replacement mic frame on that same private stdio pipe. This temporary
//! base64 envelope is bounded, correlation-scoped, never logged/persisted, and
//! is not a renderer-facing API.

use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::{
    aec::{AecConfig, AecCoordinator, AecOutputRoute, AecProcessorChain, AecReferenceAlignment},
    evidence::{
        poll_bounded, EvidenceError, MeetingEvidenceSource, MeetingSurfaceObservation,
        SpeakerEvidence,
    },
    types::{
        AecEngine, AecFrameDisposition, AecFrameMetadata, AecHealth, AecReferenceTiming,
        AudioFrame, AudioFrameMetadata, CaptureHealth, Channel, FrameFlags,
    },
};

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
use crate::evidence::{AnarlogAxSource, MacosZoomAnarlogProvider};

pub const PROTOCOL_VERSION: u32 = 1;
/// An Accessibility observation is sampled, not a continuous recording.
pub const EVIDENCE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MIN_CONSECUTIVE_EVIDENCE_SAMPLES: u64 = 3_200;
const MAX_CONSECUTIVE_EVIDENCE_GAP_SAMPLES: u64 = 12_000;
const COMMAND_QUEUE_CAPACITY: usize = 32;
const MAX_EVIDENCE_PER_POLL: usize = 8;
const MEETING_END_MISSING_SURFACE_POLLS: u8 = 3;
const AEC_SAMPLES_PER_FRAME: usize = 320;
const AEC_PCM_BYTES_PER_FRAME: usize = AEC_SAMPLES_PER_FRAME * 2;
const MAX_AEC_RESULT_FRAMES: usize = 8;

/// Commands accepted from Electron main over a private stdio pipe.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlCommand {
    Ping {
        request_id: String,
    },
    Start {
        meeting_id: String,
        #[serde(default)]
        aec_output_route: Option<PrivateAecOutputRoute>,
    },
    Stop {
        meeting_id: String,
    },
    Status {
        meeting_id: String,
    },
    /// Private Electron-main-only process request. Both payloads are exact
    /// 20 ms 16 kHz mono PCM frames, bounded below before decoding.
    AecProcess {
        request_id: String,
        meeting_id: String,
        mic: PrivateAecInputFrame,
        render: PrivateAecInputFrame,
    },
    /// Releases the coordinator/reblocker tail raw before ASR finalization.
    AecFlush {
        request_id: String,
        meeting_id: String,
    },
    /// Private Electron-main-only output-device transition. It preserves the
    /// active evidence session and source clock; the coordinator only releases
    /// its bounded, already-held microphone tail raw before switching modes.
    AecRouteUpdate {
        request_id: String,
        meeting_id: String,
        aec_output_route: PrivateAecOutputRoute,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivateAecOutputRoute {
    Speaker,
    Isolated,
}

impl From<PrivateAecOutputRoute> for AecOutputRoute {
    fn from(value: PrivateAecOutputRoute) -> Self {
        match value {
            PrivateAecOutputRoute::Speaker => Self::Speaker,
            PrivateAecOutputRoute::Isolated => Self::Isolated,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PrivateChannel {
    Mic,
    System,
}

impl From<PrivateChannel> for Channel {
    fn from(value: PrivateChannel) -> Self {
        match value {
            PrivateChannel::Mic => Self::Mic,
            PrivateChannel::System => Self::System,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
struct PrivateFrameFlags {
    discontinuity: bool,
    recovered: bool,
    silence: bool,
}

impl From<PrivateFrameFlags> for FrameFlags {
    fn from(value: PrivateFrameFlags) -> Self {
        Self {
            discontinuity: value.discontinuity,
            recovered: value.recovered,
            silence: value.silence,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PrivateAecInputFrame {
    source_id: String,
    channel: PrivateChannel,
    start_sample: u64,
    sample_count: u32,
    sample_rate: u32,
    sequence: u64,
    epoch: u64,
    flags: PrivateFrameFlags,
    pcm_base64: String,
}

/// Small parse failure used inside the private PCM boundary. Keeping this
/// distinct from the public `BridgeEvent` avoids carrying a large serialized
/// event through every validation branch; the caller projects it once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrivateAecInputError {
    InvalidFrame,
    InvalidEncoding,
    NonCanonicalPcm,
}

impl PrivateAecInputError {
    fn into_event(self) -> BridgeEvent {
        match self {
            Self::InvalidFrame => BridgeEvent::Error {
                code: "invalid_aec_frame",
                message: "AEC requires one bounded 20 ms 16 kHz mono frame".into(),
            },
            Self::InvalidEncoding => BridgeEvent::Error {
                code: "invalid_aec_frame",
                message: "AEC PCM encoding is invalid".into(),
            },
            Self::NonCanonicalPcm => BridgeEvent::Error {
                code: "invalid_aec_frame",
                message: "AEC PCM must be canonical one-frame signed-16 audio".into(),
            },
        }
    }
}

/// Events emitted by the bridge. This is NDJSON, one complete object per line;
/// malformed or oversized lines are rejected by the caller before decoding.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeEvent {
    Ready {
        protocol_version: u32,
    },
    Pong {
        request_id: String,
    },
    CaptureHealth {
        health: CaptureHealth,
    },
    /// AEC health is independent from capture lifecycle.  It contains only
    /// bounded counters/state and never serializes audio or model diagnostics.
    AecHealth {
        health: AecHealth,
    },
    /// Correlation-scoped private result for Electron main. It is never
    /// forwarded through the renderer event projection.
    AecResult {
        request_id: String,
        meeting_id: String,
        frames: Vec<PrivateAecOutputFrame>,
    },
    AudioFrame {
        metadata: AudioFrameMetadata,
    },
    SpeakerEvidence {
        evidence: SpeakerEvidence,
    },
    MeetingLifecycle {
        meeting_id: String,
        state: MeetingLifecycleState,
    },
    Backpressure {
        channel: crate::types::Channel,
        dropped_frames: u64,
        capacity: usize,
    },
    Error {
        code: &'static str,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingLifecycleState {
    Active,
    Ended,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrivateAecOutputFrame {
    metadata: PrivateAecOutputMetadata,
    pcm_base64: String,
    aec: AecFrameMetadata,
}

/// Deliberately excludes `AudioFrameMetadata::aec`: it is emitted exactly once
/// in the sibling `aec` property so Electron main can require provenance while
/// retaining its existing general audio-frame metadata parser.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct PrivateAecOutputMetadata {
    meeting_id: String,
    source_id: String,
    channel: Channel,
    start_sample: u64,
    sample_count: u32,
    sample_rate: u32,
    sequence: u64,
    epoch: u64,
    flags: FrameFlags,
}

/// Read one bounded NDJSON command. The caller owns the loop so it can combine
/// commands with capture polling without creating a renderer-side audio path.
pub fn decode_command(line: &str) -> Result<ControlCommand, ProtocolError> {
    if line.len() > 64 * 1024 {
        return Err(ProtocolError::LineTooLong);
    }
    serde_json::from_str(line).map_err(ProtocolError::Json)
}

/// Write exactly one NDJSON event. `AudioFrame` only contains metadata; there
/// is intentionally no branch that serializes PCM here.
pub fn write_event(mut writer: impl Write, event: &BridgeEvent) -> Result<(), ProtocolError> {
    serde_json::to_writer(&mut writer, event).map_err(ProtocolError::Json)?;
    writer.write_all(b"\n").map_err(ProtocolError::Io)?;
    writer.flush().map_err(ProtocolError::Io)
}

/// A factory for evidence-only sessions. The default factory is deliberately
/// disabled: control commands cannot select a device, credentials, or audio
/// backend over stdio.
trait EvidenceSessionFactory {
    fn create(
        &mut self,
        meeting_id: &str,
        started_at: Instant,
    ) -> Option<Box<dyn MeetingEvidenceSource>>;
}

#[cfg(any(test, not(all(target_os = "macos", feature = "anarlog-ax"))))]
#[derive(Debug, Default)]
struct DisabledEvidenceFactory;

#[cfg(any(test, not(all(target_os = "macos", feature = "anarlog-ax"))))]
impl EvidenceSessionFactory for DisabledEvidenceFactory {
    fn create(&mut self, _: &str, _: Instant) -> Option<Box<dyn MeetingEvidenceSource>> {
        None
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Default)]
struct MacosAnarlogEvidenceFactory;

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl EvidenceSessionFactory for MacosAnarlogEvidenceFactory {
    fn create(
        &mut self,
        meeting_id: &str,
        started_at: Instant,
    ) -> Option<Box<dyn MeetingEvidenceSource>> {
        Some(Box::new(AnarlogAxSource::new(
            meeting_id,
            MacosZoomAnarlogProvider::new(started_at),
        )))
    }
}

struct ActiveEvidence {
    meeting_id: String,
    source: Box<dyn MeetingEvidenceSource>,
    previous_active_points: HashMap<SpeakerKey, u64>,
    meeting_surface_seen: bool,
    missing_surface_polls: u8,
    meeting_end_emitted: bool,
}

/// Per-meeting private AEC coordinator. It has no access to the renderer,
/// network, ASR session, device names, or persistent storage.
struct ActiveAec {
    meeting_id: String,
    coordinator: AecCoordinator,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SpeakerKey {
    participant_id: Option<String>,
    display_name: String,
    is_self: Option<bool>,
}

impl ActiveEvidence {
    fn lifecycle_event(&mut self) -> Option<BridgeEvent> {
        match self.source.surface_observation() {
            MeetingSurfaceObservation::Active => {
                self.missing_surface_polls = 0;
                if self.meeting_surface_seen {
                    None
                } else {
                    self.meeting_surface_seen = true;
                    Some(BridgeEvent::MeetingLifecycle {
                        meeting_id: self.meeting_id.clone(),
                        state: MeetingLifecycleState::Active,
                    })
                }
            }
            MeetingSurfaceObservation::Missing
                if self.meeting_surface_seen && !self.meeting_end_emitted =>
            {
                self.missing_surface_polls = self.missing_surface_polls.saturating_add(1);
                if self.missing_surface_polls < MEETING_END_MISSING_SURFACE_POLLS {
                    return None;
                }
                self.meeting_end_emitted = true;
                Some(BridgeEvent::MeetingLifecycle {
                    meeting_id: self.meeting_id.clone(),
                    state: MeetingLifecycleState::Ended,
                })
            }
            MeetingSurfaceObservation::Unknown => {
                self.missing_surface_polls = 0;
                None
            }
            MeetingSurfaceObservation::Missing => None,
        }
    }

    /// Emits only intervals between two observations of the same named active
    /// speaker. A point can establish a baseline, never a future duration.
    fn consecutive_speaker_events(
        &mut self,
        observations: Vec<SpeakerEvidence>,
    ) -> Vec<BridgeEvent> {
        let mut current_points = HashMap::new();
        for observation in observations {
            let Some((key, observation)) = strict_named_active_point(&self.meeting_id, observation)
            else {
                continue;
            };
            // Duplicate labels in the same AX snapshot do not establish
            // continuity; retain the first point only.
            current_points.entry(key).or_insert(observation);
        }

        // Any speaker absent from this poll (including roster-only/inactive
        // rows) loses continuity. This prevents stale AX state from naming a
        // later transcript span after an unobserved transition.
        let previous_points = std::mem::take(&mut self.previous_active_points);
        let mut events = Vec::new();
        for (key, mut observation) in current_points {
            if let Some(start_sample) = previous_points.get(&key) {
                if let Some(sample_gap) = observation
                    .observed_at_sample
                    .checked_sub(*start_sample)
                    .filter(|gap| {
                        (MIN_CONSECUTIVE_EVIDENCE_SAMPLES..=MAX_CONSECUTIVE_EVIDENCE_GAP_SAMPLES)
                            .contains(gap)
                    })
                {
                    observation.start_sample = observation.observed_at_sample - sample_gap;
                    observation.end_sample = observation.observed_at_sample;
                    events.push(BridgeEvent::SpeakerEvidence {
                        evidence: observation.clone(),
                    });
                }
            }
            self.previous_active_points
                .insert(key, observation.observed_at_sample);
        }
        events
    }
}

/// Evidence-only control state. It cannot create or observe any audio source.
/// Its single caller owns both state transitions and stdout writes.
struct ControlHost<F> {
    factory: F,
    active_meeting_id: Option<String>,
    active_evidence: Option<ActiveEvidence>,
    active_aec: Option<ActiveAec>,
    next_poll_at: Option<Instant>,
}

impl<F: EvidenceSessionFactory> ControlHost<F> {
    fn new(factory: F) -> Self {
        Self {
            factory,
            active_meeting_id: None,
            active_evidence: None,
            active_aec: None,
            next_poll_at: None,
        }
    }

    fn handle(&mut self, command: ControlCommand, now: Instant) -> Vec<BridgeEvent> {
        match command {
            ControlCommand::Ping { request_id } => vec![BridgeEvent::Pong { request_id }],
            ControlCommand::Start {
                meeting_id,
                aec_output_route,
            } => {
                let output_route = aec_output_route
                    .map(AecOutputRoute::from)
                    .unwrap_or(AecOutputRoute::Unknown);
                self.active_meeting_id = Some(meeting_id.clone());
                self.active_aec = Some(ActiveAec {
                    coordinator: configured_aec(&meeting_id, output_route),
                    meeting_id: meeting_id.clone(),
                });
                self.active_evidence =
                    self.factory
                        .create(&meeting_id, now)
                        .map(|source| ActiveEvidence {
                            meeting_id: meeting_id.clone(),
                            source,
                            previous_active_points: HashMap::new(),
                            meeting_surface_seen: false,
                            missing_surface_polls: 0,
                            meeting_end_emitted: false,
                        });
                // Poll on the next turn rather than from the command handler,
                // so the stdio loop remains the only stdout writer and every
                // AX call has the same bounded scheduling path.
                self.next_poll_at = self.active_evidence.as_ref().map(|_| now);
                let mut events = Vec::new();
                if self.active_evidence.is_none()
                    && self
                        .active_aec
                        .as_ref()
                        .is_some_and(|active| active.coordinator.health().engine.is_none())
                {
                    events.push(source_configuration_required());
                }
                events
            }
            ControlCommand::Stop { meeting_id } => {
                if self.active_meeting_id.as_deref() != Some(meeting_id.as_str()) {
                    vec![BridgeEvent::Error {
                        code: "bridge_not_started",
                        message: "no supervised meeting evidence is active for this meeting".into(),
                    }]
                } else {
                    let frames = self
                        .active_aec
                        .as_mut()
                        .map(|active| active.coordinator.flush())
                        .unwrap_or_default();
                    self.active_meeting_id = None;
                    self.active_evidence = None;
                    self.active_aec = None;
                    self.next_poll_at = None;
                    if frames.is_empty() {
                        Vec::new()
                    } else {
                        vec![BridgeEvent::AecResult {
                            request_id: "stop".into(),
                            meeting_id,
                            frames: private_aec_output_frames(frames),
                        }]
                    }
                }
            }
            ControlCommand::Status { meeting_id } => {
                if self.active_meeting_id.as_deref() == Some(meeting_id.as_str()) {
                    // There is deliberately no success-status event here: the
                    // bridge has not started an audio source. Evidence is
                    // observable only through bounded `speaker_evidence`.
                    Vec::new()
                } else {
                    vec![BridgeEvent::Error {
                        code: "bridge_not_started",
                        message: "no supervised capture or meeting evidence has been configured"
                            .into(),
                    }]
                }
            }
            ControlCommand::AecProcess {
                request_id,
                meeting_id,
                mic,
                render,
            } => self.process_aec(request_id, meeting_id, mic, render),
            ControlCommand::AecFlush {
                request_id,
                meeting_id,
            } => self.flush_aec(request_id, meeting_id),
            ControlCommand::AecRouteUpdate {
                request_id,
                meeting_id,
                aec_output_route,
            } => self.update_aec_output_route(request_id, meeting_id, aec_output_route.into()),
        }
    }

    fn process_aec(
        &mut self,
        request_id: String,
        meeting_id: String,
        mic: PrivateAecInputFrame,
        render: PrivateAecInputFrame,
    ) -> Vec<BridgeEvent> {
        let mic = match private_input_to_frame(&meeting_id, mic, Channel::Mic) {
            Ok(frame) => frame,
            Err(error) => return vec![error.into_event()],
        };
        let render = match private_input_to_frame(&meeting_id, render, Channel::System) {
            Ok(frame) => frame,
            Err(error) => return vec![error.into_event()],
        };
        if render.start_sample != mic.start_sample || render.epoch != mic.epoch {
            return vec![BridgeEvent::Error {
                code: "aec_pair_clock_mismatch",
                message: "paired AEC frames require a shared sample position and epoch".into(),
            }];
        }
        let Some(active) = self
            .active_aec
            .as_mut()
            .filter(|active| active.meeting_id == meeting_id)
        else {
            return vec![BridgeEvent::Error {
                code: "aec_not_started",
                message: "no matching AEC coordinator is active for this meeting".into(),
            }];
        };

        // `push_mic` handles processor failures by returning raw microphone
        // frames. Any format/coordinator error still follows the same raw
        // behavior for this incoming mic frame instead of discarding speech.
        let frames = match active.coordinator.push_render(render) {
            Ok(mut released) => match active.coordinator.push_mic(mic.clone()) {
                Ok(mut current) => {
                    released.append(&mut current);
                    released
                }
                Err(_) => {
                    // A render push may have released older held microphone
                    // frames before the current mic push failed. Preserve that
                    // ordered raw-safe prefix as well as the incoming frame.
                    released.push(raw_aec_frame(mic));
                    released
                }
            },
            Err(_) => vec![raw_aec_frame(mic)],
        };
        let mut events = vec![BridgeEvent::AecResult {
            request_id,
            meeting_id,
            frames: private_aec_output_frames(frames),
        }];
        if let Some(health) = active.coordinator.take_health_update() {
            events.push(BridgeEvent::AecHealth { health });
        }
        events
    }

    fn flush_aec(&mut self, request_id: String, meeting_id: String) -> Vec<BridgeEvent> {
        let Some(active) = self
            .active_aec
            .as_mut()
            .filter(|active| active.meeting_id == meeting_id)
        else {
            return vec![BridgeEvent::Error {
                code: "aec_not_started",
                message: "no matching AEC coordinator is active for this meeting".into(),
            }];
        };
        let frames = active.coordinator.flush();
        let mut events = vec![BridgeEvent::AecResult {
            request_id,
            meeting_id,
            frames: private_aec_output_frames(frames),
        }];
        if let Some(health) = active.coordinator.take_health_update() {
            events.push(BridgeEvent::AecHealth { health });
        }
        events
    }

    /// Changes only the AEC route. In particular, it does not recreate AX
    /// evidence, touch `next_poll_at`, or synthesize a new source epoch. The
    /// returned result is the coordinator's raw-safe release of any bounded
    /// holdback, and must be handed to the existing Electron-main AEC router.
    fn update_aec_output_route(
        &mut self,
        request_id: String,
        meeting_id: String,
        output_route: AecOutputRoute,
    ) -> Vec<BridgeEvent> {
        let Some(active) = self
            .active_aec
            .as_mut()
            .filter(|active| active.meeting_id == meeting_id)
        else {
            return vec![BridgeEvent::Error {
                code: "aec_not_started",
                message: "no matching AEC coordinator is active for this meeting".into(),
            }];
        };
        let frames = active.coordinator.set_output_route(output_route);
        let mut events = vec![BridgeEvent::AecResult {
            request_id,
            meeting_id,
            frames: private_aec_output_frames(frames),
        }];
        if let Some(health) = active.coordinator.take_health_update() {
            events.push(BridgeEvent::AecHealth { health });
        }
        events
    }

    fn next_poll_at(&self) -> Option<Instant> {
        self.next_poll_at
    }

    fn poll_due(&mut self, now: Instant) -> Vec<BridgeEvent> {
        if self.next_poll_at.is_none_or(|deadline| now < deadline) {
            return Vec::new();
        }

        let result = {
            let Some(active) = self.active_evidence.as_mut() else {
                self.next_poll_at = None;
                return Vec::new();
            };
            poll_bounded(active.source.as_mut(), MAX_EVIDENCE_PER_POLL)
        };
        // Schedule from poll completion, not its requested deadline. An AX
        // call may take up to its own bounded timeout; scheduling from the old
        // deadline would otherwise cause immediate catch-up polling.
        self.next_poll_at = Some(Instant::now() + EVIDENCE_POLL_INTERVAL);

        match result {
            Ok(observations) => self
                .active_evidence
                .as_mut()
                .map_or_else(Vec::new, |active| {
                    let mut events = active.lifecycle_event().into_iter().collect::<Vec<_>>();
                    events.extend(active.consecutive_speaker_events(observations));
                    events
                }),
            Err(error) => {
                // A failed AX poll is not a reason to retain stale speaker
                // state or retry in a tight loop. Electron main can surface a
                // bounded error and explicitly start a fresh evidence session
                // after the user changes TCC or Zoom state.
                self.active_evidence = None;
                self.next_poll_at = None;
                vec![evidence_error_event(error)]
            }
        }
    }
}

fn source_configuration_required() -> BridgeEvent {
    BridgeEvent::Error {
        code: "source_configuration_required",
        message: "Electron main must construct the selected AudioSource; the control protocol never carries device credentials or PCM.".into(),
    }
}

fn configured_aec(meeting_id: &str, output_route: AecOutputRoute) -> AecCoordinator {
    let config = AecConfig {
        // `MeetingAecRouter` admits only explicitly paired input frames with
        // equal position/epoch. That gives this private lane one trusted
        // renderer capture clock without merging the independent ASR clocks.
        alignment: AecReferenceAlignment::trusted(0),
        // Bound a LocalVQE/WebRTC reblocking tail so private stdio can emit at
        // most eight frames during an explicit flush.
        maximum_pending_mic_frames: 4,
        ..AecConfig::default()
    };
    match selected_aec_processor() {
        Ok(processor) => {
            AecCoordinator::with_processor(meeting_id, config, output_route, processor)
                .unwrap_or_else(|_| AecCoordinator::disabled(meeting_id, output_route))
        }
        Err(_) => AecCoordinator::disabled(meeting_id, output_route),
    }
}

/// Resolve only explicitly compiled, explicitly selected processors. A
/// missing model, library, feature, or malformed selection becomes raw
/// bypass—not a download, crash, or an implicit system DSP dependency.
fn selected_aec_processor() -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    // Development/test helpers remain an explicit opt-in. Merely compiling an
    // AEC feature (or exporting qualification asset paths for one adapter
    // smoke test) must not make every unrelated protocol test/session load a
    // model or accept PCM. Release helpers have no arbitrary path inputs and
    // are activated only by Electron main after it verifies the fixed signed
    // package resources.
    if cfg!(debug_assertions) && std::env::var("ROWBOAT_MEETING_AEC_ENABLED").as_deref() != Ok("1")
    {
        return Err(crate::aec::AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        });
    }
    // A packaged helper defaults to the signed, package-adjacent LocalVQE
    // assets plus the compiled AEC3 comparator. Missing assets fail open to
    // raw/evidence-only capture; no development launcher variable is needed.
    // `ROWBOAT_MEETING_AEC_ENGINE` is debug-only selection support and is
    // ignored by release helpers so it cannot redirect packaged behavior.
    let requested_engine = if cfg!(debug_assertions) {
        std::env::var("ROWBOAT_MEETING_AEC_ENGINE").ok()
    } else {
        None
    };
    match requested_engine.as_deref() {
        Some("webrtc_aec3") => selected_webrtc_aec3(),
        Some("localvqe") => selected_localvqe(),
        // The default under the AEC gate is LocalVQE primary with WebRTC AEC3
        // as its per-frame comparator/fallback when that reviewed feature is
        // present. If LocalVQE assets are absent, a compiled AEC3 remains a
        // viable raw-safe comparator rather than stopping the meeting.
        Some("localvqe_with_webrtc_aec3_fallback") | Some("") | None => {
            selected_localvqe_with_webrtc_fallback()
        }
        _ => Err(crate::aec::AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        }),
    }
}

#[cfg(feature = "aec-localvqe")]
fn selected_localvqe() -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    crate::aec::localvqe::build_aec_processor()
}

#[cfg(not(feature = "aec-localvqe"))]
fn selected_localvqe() -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    Err(crate::aec::AecError::BindingUnavailable {
        engine: AecEngine::LocalVqe,
    })
}

#[cfg(feature = "aec-webrtc-aec3")]
fn selected_webrtc_aec3() -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    crate::aec::webrtc_aec3::build_aec_processor()
}

#[cfg(not(feature = "aec-webrtc-aec3"))]
fn selected_webrtc_aec3() -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    Err(crate::aec::AecError::BindingUnavailable {
        engine: AecEngine::WebRtcAec3,
    })
}

fn selected_localvqe_with_webrtc_fallback(
) -> Result<Box<dyn crate::aec::AecProcessor>, crate::aec::AecError> {
    match selected_localvqe() {
        Ok(primary) => {
            let fallback = selected_webrtc_aec3().ok();
            Ok(Box::new(AecProcessorChain::new(primary, fallback)))
        }
        Err(_) => selected_webrtc_aec3(),
    }
}

fn private_input_to_frame(
    meeting_id: &str,
    input: PrivateAecInputFrame,
    expected_channel: Channel,
) -> Result<AudioFrame, PrivateAecInputError> {
    if Channel::from(input.channel) != expected_channel
        || input.source_id.is_empty()
        || input.source_id.len() > 160
        || input.sample_count as usize != AEC_SAMPLES_PER_FRAME
        || input.sample_rate != 16_000
        || input.pcm_base64.len() > 4_096
    {
        return Err(PrivateAecInputError::InvalidFrame);
    }
    let bytes = BASE64
        .decode(&input.pcm_base64)
        .map_err(|_| PrivateAecInputError::InvalidEncoding)?;
    if bytes.len() != AEC_PCM_BYTES_PER_FRAME || BASE64.encode(&bytes) != input.pcm_base64 {
        return Err(PrivateAecInputError::NonCanonicalPcm);
    }
    let pcm_s16le = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    Ok(AudioFrame {
        meeting_id: meeting_id.to_owned(),
        source_id: input.source_id,
        channel: expected_channel,
        start_sample: input.start_sample,
        sample_count: input.sample_count,
        sample_rate: input.sample_rate,
        sequence: input.sequence,
        epoch: input.epoch,
        flags: input.flags.into(),
        aec: None,
        pcm_s16le,
    })
}

fn raw_aec_frame(mut frame: AudioFrame) -> AudioFrame {
    frame.aec = Some(AecFrameMetadata {
        engine: None,
        disposition: AecFrameDisposition::BypassedProcessorFailure,
        reference_timing: AecReferenceTiming::Missing,
        reference_offset_samples: None,
    });
    frame
}

fn private_aec_output_frames(frames: Vec<AudioFrame>) -> Vec<PrivateAecOutputFrame> {
    // The coordinator configuration bounds a flush to eight full bridge
    // frames. Preserve safety if a future change violates that invariant: emit
    // no partial result, so Electron's retained raw frames fail open instead.
    if frames.len() > MAX_AEC_RESULT_FRAMES {
        return Vec::new();
    }
    frames
        .into_iter()
        .filter_map(|frame| {
            let aec = frame.aec.clone()?;
            (frame.channel == Channel::Mic
                && frame.sample_count as usize == AEC_SAMPLES_PER_FRAME
                && frame.pcm_s16le.len() == AEC_SAMPLES_PER_FRAME)
                .then(|| PrivateAecOutputFrame {
                    metadata: PrivateAecOutputMetadata {
                        meeting_id: frame.meeting_id,
                        source_id: frame.source_id,
                        channel: frame.channel,
                        start_sample: frame.start_sample,
                        sample_count: frame.sample_count,
                        sample_rate: frame.sample_rate,
                        sequence: frame.sequence,
                        epoch: frame.epoch,
                        flags: frame.flags,
                    },
                    pcm_base64: encode_pcm(&frame.pcm_s16le),
                    aec,
                })
        })
        .collect()
}

fn encode_pcm(pcm_s16le: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(pcm_s16le.len() * 2);
    for sample in pcm_s16le {
        bytes.extend(sample.to_le_bytes());
    }
    BASE64.encode(bytes)
}

fn evidence_error_event(error: EvidenceError) -> BridgeEvent {
    let (code, message) = match error {
        EvidenceError::PermissionDenied => (
            "accessibility_permission_required",
            "Accessibility permission is required before native Zoom speaker evidence can be read.",
        ),
        EvidenceError::Unavailable(_) => (
            "speaker_evidence_unavailable",
            "native Zoom speaker evidence is unavailable; audio capture has not changed.",
        ),
        EvidenceError::Backend(_) => (
            "speaker_evidence_failed",
            "native Zoom speaker evidence failed; audio capture has not changed.",
        ),
    };
    BridgeEvent::Error {
        code,
        message: message.into(),
    }
}

/// Accept only an unambiguous point observation that can contribute to a
/// consecutive-observation interval. This deliberately does not infer any
/// duration from one sample.
fn strict_named_active_point(
    meeting_id: &str,
    evidence: SpeakerEvidence,
) -> Option<(SpeakerKey, SpeakerEvidence)> {
    let display_name = evidence
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    if evidence.meeting_id != meeting_id
        || evidence.platform != "zoom"
        || evidence.surface != "native"
        || evidence.source != crate::evidence::EvidenceSource::ZoomAx
        || evidence.is_active != Some(true)
        || evidence.start_sample != evidence.observed_at_sample
        || evidence.end_sample != evidence.observed_at_sample
    {
        return None;
    }
    Some((
        SpeakerKey {
            participant_id: evidence
                .participant_id
                .as_deref()
                .map(str::trim)
                .filter(|participant_id| !participant_id.is_empty())
                .map(str::to_owned),
            display_name: display_name.to_ascii_lowercase(),
            is_self: evidence.is_self,
        },
        evidence,
    ))
}

/// The standalone control host keeps source construction out of Electron's
/// renderer protocol. On macOS with `anarlog-ax` it has an evidence-only Zoom
/// source; all other builds retain the existing fail-closed Start behavior.
pub fn serve_control_stdio() -> Result<(), ProtocolError> {
    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    return serve_control_stdio_with_factory(MacosAnarlogEvidenceFactory);

    #[cfg(not(all(target_os = "macos", feature = "anarlog-ax")))]
    serve_control_stdio_with_factory(DisabledEvidenceFactory)
}

fn serve_control_stdio_with_factory<F: EvidenceSessionFactory>(
    factory: F,
) -> Result<(), ProtocolError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    write_event(
        &mut writer,
        &BridgeEvent::Ready {
            protocol_version: PROTOCOL_VERSION,
        },
    )?;

    let commands = spawn_command_reader(stdin);
    let mut host = ControlHost::new(factory);
    loop {
        let command = receive_until_poll(&commands, host.next_poll_at());
        match command {
            Ok(Some(Ok(command))) => {
                for event in host.handle(command, Instant::now()) {
                    write_event(&mut writer, &event)?;
                }
            }
            Ok(Some(Err(error))) => write_event(
                &mut writer,
                &BridgeEvent::Error {
                    code: "invalid_command",
                    message: error.to_string(),
                },
            )?,
            Ok(None) => return Ok(()),
            Err(()) => {}
        }
        for event in host.poll_due(Instant::now()) {
            write_event(&mut writer, &event)?;
        }
    }
}

fn spawn_command_reader(stdin: io::Stdin) -> Receiver<Result<ControlCommand, ProtocolError>> {
    let (sender, receiver) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
    std::thread::spawn(move || {
        for line in stdin.lock().lines() {
            let command = line
                .map_err(ProtocolError::Io)
                .and_then(|line| decode_command(&line));
            if sender.send(command).is_err() {
                break;
            }
        }
    });
    receiver
}

/// `Ok(None)` means stdin closed. `Err(())` is only a scheduled poll timeout;
/// the loop immediately polls once and then sleeps on the channel again.
fn receive_until_poll(
    commands: &Receiver<Result<ControlCommand, ProtocolError>>,
    next_poll_at: Option<Instant>,
) -> Result<Option<Result<ControlCommand, ProtocolError>>, ()> {
    let received = match next_poll_at {
        Some(deadline) => commands.recv_timeout(deadline.saturating_duration_since(Instant::now())),
        None => return Ok(commands.recv().ok()),
    };
    match received {
        Ok(command) => Ok(Some(command)),
        Err(RecvTimeoutError::Timeout) => Err(()),
        Err(RecvTimeoutError::Disconnected) => Ok(None),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("NDJSON line exceeds the 64 KiB command limit")]
    LineTooLong,
    #[error("invalid protocol JSON: {0}")]
    Json(serde_json::Error),
    #[error("protocol I/O failed: {0}")]
    Io(io::Error),
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        time::{Duration, Instant},
    };

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    use crate::{
        evidence::{
            EvidenceError, EvidenceSource, MeetingEvidenceSource, MeetingSurfaceObservation,
            SpeakerEvidence,
        },
        protocol::{
            write_event, BridgeEvent, ControlCommand, ControlHost, DisabledEvidenceFactory,
            EvidenceSessionFactory, PrivateAecInputFrame, PrivateAecOutputRoute, PrivateChannel,
            PrivateFrameFlags, AEC_PCM_BYTES_PER_FRAME, EVIDENCE_POLL_INTERVAL,
        },
        types::{AudioFrame, AudioFrameMetadata, Channel, FrameFlags},
    };

    struct FakeEvidenceSource {
        polls: VecDeque<Result<Vec<SpeakerEvidence>, EvidenceError>>,
    }

    impl MeetingEvidenceSource for FakeEvidenceSource {
        fn source_id(&self) -> &str {
            "fake_anarlog_provider"
        }

        fn poll(&mut self, _: usize) -> Result<Vec<SpeakerEvidence>, EvidenceError> {
            self.polls.pop_front().unwrap_or_else(|| Ok(Vec::new()))
        }
    }

    struct FakeEvidenceFactory {
        source: Option<FakeEvidenceSource>,
    }

    impl EvidenceSessionFactory for FakeEvidenceFactory {
        fn create(&mut self, _: &str, _: Instant) -> Option<Box<dyn MeetingEvidenceSource>> {
            self.source
                .take()
                .map(|source| Box::new(source) as Box<dyn MeetingEvidenceSource>)
        }
    }

    struct LifecycleEvidenceSource {
        observations: VecDeque<MeetingSurfaceObservation>,
        current: MeetingSurfaceObservation,
    }

    impl MeetingEvidenceSource for LifecycleEvidenceSource {
        fn source_id(&self) -> &str {
            "lifecycle_zoom_provider"
        }

        fn poll(&mut self, _: usize) -> Result<Vec<SpeakerEvidence>, EvidenceError> {
            self.current = self
                .observations
                .pop_front()
                .unwrap_or(MeetingSurfaceObservation::Unknown);
            Ok(Vec::new())
        }

        fn surface_observation(&self) -> MeetingSurfaceObservation {
            self.current
        }
    }

    struct LifecycleEvidenceFactory {
        source: Option<LifecycleEvidenceSource>,
    }

    impl EvidenceSessionFactory for LifecycleEvidenceFactory {
        fn create(&mut self, _: &str, _: Instant) -> Option<Box<dyn MeetingEvidenceSource>> {
            self.source
                .take()
                .map(|source| Box::new(source) as Box<dyn MeetingEvidenceSource>)
        }
    }

    fn evidence(
        meeting_id: &str,
        sample: u64,
        name: Option<&str>,
        is_active: Option<bool>,
    ) -> SpeakerEvidence {
        SpeakerEvidence {
            meeting_id: meeting_id.into(),
            start_sample: sample,
            end_sample: sample,
            platform: "zoom".into(),
            surface: "native".into(),
            participant_id: Some("ax-p1".into()),
            display_name: name.map(str::to_owned),
            is_self: Some(false),
            is_active,
            is_muted: None,
            source: EvidenceSource::ZoomAx,
            confidence: 0.95,
            observed_at_sample: sample,
            signals: vec!["speaker-state-label".into()],
        }
    }

    fn private_aec_frame(
        channel: PrivateChannel,
        start_sample: u64,
        epoch: u64,
    ) -> PrivateAecInputFrame {
        PrivateAecInputFrame {
            source_id: match channel {
                PrivateChannel::Mic => "meeting.mic".into(),
                PrivateChannel::System => "meeting.system".into(),
            },
            channel,
            start_sample,
            sample_count: 320,
            sample_rate: 16_000,
            sequence: start_sample / 320,
            epoch,
            flags: PrivateFrameFlags {
                discontinuity: false,
                recovered: false,
                silence: false,
            },
            pcm_base64: BASE64.encode(vec![0_u8; AEC_PCM_BYTES_PER_FRAME]),
        }
    }

    #[test]
    fn frame_event_contains_metadata_but_never_pcm() {
        let frame = AudioFrame {
            meeting_id: "meeting".into(),
            source_id: "system".into(),
            channel: Channel::System,
            start_sample: 0,
            sample_count: 320,
            sample_rate: 16_000,
            sequence: 0,
            epoch: 0,
            flags: FrameFlags::default(),
            aec: None,
            pcm_s16le: vec![42; 320],
        };
        let mut encoded = Vec::new();
        write_event(
            &mut encoded,
            &BridgeEvent::AudioFrame {
                metadata: AudioFrameMetadata::from(&frame),
            },
        )
        .expect("event");
        let json = String::from_utf8(encoded).expect("UTF-8 JSON");
        assert!(!json.contains("pcm"));
        assert!(!json.contains("42"));
        assert!(json.contains("sample_count"));
    }

    #[test]
    fn disabled_default_start_retains_the_fail_closed_audio_boundary() {
        let mut host = ControlHost::new(DisabledEvidenceFactory);
        let events = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
                aec_output_route: None,
            },
            Instant::now(),
        );
        assert!(matches!(
            events.as_slice(),
            [BridgeEvent::Error {
                code: "source_configuration_required",
                ..
            }]
        ));
        assert!(host.next_poll_at().is_none());
    }

    #[test]
    fn route_update_preserves_active_evidence_and_the_renderer_sample_clock() {
        let mut host = ControlHost::new(FakeEvidenceFactory {
            source: Some(FakeEvidenceSource {
                polls: VecDeque::new(),
            }),
        });
        let now = Instant::now();
        assert!(host
            .handle(
                ControlCommand::Start {
                    meeting_id: "meeting".into(),
                    aec_output_route: Some(PrivateAecOutputRoute::Speaker),
                },
                now,
            )
            .is_empty());
        let poll_before = host.next_poll_at();

        let events = host.handle(
            ControlCommand::AecRouteUpdate {
                request_id: "devicechange".into(),
                meeting_id: "meeting".into(),
                aec_output_route: PrivateAecOutputRoute::Isolated,
            },
            now + Duration::from_millis(1),
        );
        assert!(events.iter().any(|event| matches!(
            event,
            BridgeEvent::AecResult { request_id, meeting_id, frames }
                if request_id == "devicechange" && meeting_id == "meeting" && frames.is_empty()
        )));
        assert_eq!(host.active_meeting_id.as_deref(), Some("meeting"));
        assert_eq!(
            host.active_evidence
                .as_ref()
                .map(|evidence| evidence.meeting_id.as_str()),
            Some("meeting"),
            "route changes must not recreate or drop AX evidence",
        );
        assert_eq!(
            host.next_poll_at(),
            poll_before,
            "route changes must not reschedule AX polling"
        );

        let events = host.handle(
            ControlCommand::AecProcess {
                request_id: "after-devicechange".into(),
                meeting_id: "meeting".into(),
                mic: private_aec_frame(PrivateChannel::Mic, 640, 7),
                render: private_aec_frame(PrivateChannel::System, 640, 7),
            },
            now + Duration::from_millis(2),
        );
        let [BridgeEvent::AecResult { frames, .. }, ..] = events.as_slice() else {
            panic!("expected AEC result plus optional health");
        };
        let frame = frames.first().expect("isolated mic is raw-released");
        assert_eq!(
            (frame.metadata.start_sample, frame.metadata.epoch),
            (640, 7)
        );
    }

    #[test]
    fn fake_provider_emits_only_named_active_speaker_intervals() {
        let mut host = ControlHost::new(FakeEvidenceFactory {
            source: Some(FakeEvidenceSource {
                polls: VecDeque::from([
                    Ok(vec![
                        evidence("meeting", 8_000, Some("Akbar"), Some(true)),
                        evidence("meeting", 8_000, Some("Roster Person"), None),
                        evidence("meeting", 8_000, None, Some(true)),
                        evidence("another-meeting", 8_000, Some("Wrong Meeting"), Some(true)),
                    ]),
                    Ok(vec![
                        evidence("meeting", 12_000, Some("Akbar"), Some(true)),
                        evidence("meeting", 12_000, Some("Roster Person"), None),
                        evidence("meeting", 12_000, None, Some(true)),
                        evidence("another-meeting", 12_000, Some("Wrong Meeting"), Some(true)),
                    ]),
                ]),
            }),
        });
        let now = Instant::now();
        assert!(host
            .handle(
                ControlCommand::Start {
                    meeting_id: "meeting".into(),
                    aec_output_route: None,
                },
                now,
            )
            .is_empty());

        assert!(
            host.poll_due(now).is_empty(),
            "a single point is not duration evidence"
        );
        let events = host.poll_due(now + EVIDENCE_POLL_INTERVAL + Duration::from_millis(1));
        let [BridgeEvent::SpeakerEvidence { evidence }] = events.as_slice() else {
            panic!("expected exactly one strict speaker-evidence event");
        };
        assert_eq!(evidence.display_name.as_deref(), Some("Akbar"));
        assert_eq!(evidence.observed_at_sample, 12_000);
        assert_eq!(evidence.start_sample, 8_000);
        assert_eq!(evidence.end_sample, 12_000);
        assert_eq!(
            evidence.end_sample - evidence.start_sample,
            4_000,
            "two 250 ms-spaced observations meet the resolver's 200 ms overlap gate"
        );
        assert!(host.next_poll_at().is_some());
    }

    #[test]
    fn missing_or_inactive_observations_reset_speaker_continuity() {
        let mut host = ControlHost::new(FakeEvidenceFactory {
            source: Some(FakeEvidenceSource {
                polls: VecDeque::from([
                    Ok(vec![evidence("meeting", 8_000, Some("Akbar"), Some(true))]),
                    Ok(vec![evidence("meeting", 12_000, Some("Akbar"), None)]),
                    Ok(vec![evidence("meeting", 16_000, Some("Akbar"), Some(true))]),
                    Ok(vec![evidence("meeting", 20_000, Some("Akbar"), Some(true))]),
                ]),
            }),
        });
        let now = Instant::now();
        let _ = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
                aec_output_route: None,
            },
            now,
        );
        assert!(host.poll_due(now).is_empty());
        assert!(host
            .poll_due(now + EVIDENCE_POLL_INTERVAL + Duration::from_millis(1))
            .is_empty());
        assert!(host
            .poll_due(now + EVIDENCE_POLL_INTERVAL * 2 + Duration::from_millis(2))
            .is_empty());
        let events = host.poll_due(now + EVIDENCE_POLL_INTERVAL * 3 + Duration::from_millis(3));
        let [BridgeEvent::SpeakerEvidence { evidence }] = events.as_slice() else {
            panic!("only the post-reset consecutive pair is trusted");
        };
        assert_eq!(
            (evidence.start_sample, evidence.end_sample),
            (16_000, 20_000)
        );
    }

    #[test]
    fn validated_zoom_surface_emits_one_active_and_one_debounced_end_edge() {
        let mut host = ControlHost::new(LifecycleEvidenceFactory {
            source: Some(LifecycleEvidenceSource {
                observations: VecDeque::from([
                    MeetingSurfaceObservation::Active,
                    MeetingSurfaceObservation::Missing,
                    MeetingSurfaceObservation::Missing,
                    MeetingSurfaceObservation::Missing,
                    MeetingSurfaceObservation::Missing,
                ]),
                current: MeetingSurfaceObservation::Unknown,
            }),
        });
        let now = Instant::now();
        let _ = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
                aec_output_route: None,
            },
            now,
        );

        assert!(matches!(
            host.poll_due(now).as_slice(),
            [BridgeEvent::MeetingLifecycle {
                meeting_id,
                state: super::MeetingLifecycleState::Active,
            }] if meeting_id == "meeting"
        ));
        assert!(host
            .poll_due(now + EVIDENCE_POLL_INTERVAL + Duration::from_millis(1))
            .is_empty());
        assert!(host
            .poll_due(now + EVIDENCE_POLL_INTERVAL * 2 + Duration::from_millis(2))
            .is_empty());
        assert!(matches!(
            host.poll_due(now + EVIDENCE_POLL_INTERVAL * 3 + Duration::from_millis(3))
                .as_slice(),
            [BridgeEvent::MeetingLifecycle {
                meeting_id,
                state: super::MeetingLifecycleState::Ended,
            }] if meeting_id == "meeting"
        ));
        assert!(host
            .poll_due(now + EVIDENCE_POLL_INTERVAL * 4 + Duration::from_millis(4))
            .is_empty());
    }

    #[test]
    fn stop_cancels_future_evidence_polls() {
        let mut host = ControlHost::new(FakeEvidenceFactory {
            source: Some(FakeEvidenceSource {
                polls: VecDeque::from([Ok(vec![evidence(
                    "meeting",
                    8_000,
                    Some("Akbar"),
                    Some(true),
                )])]),
            }),
        });
        let now = Instant::now();
        let _ = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
                aec_output_route: None,
            },
            now,
        );
        assert!(host
            .handle(
                ControlCommand::Stop {
                    meeting_id: "meeting".into(),
                },
                now + Duration::from_millis(10),
            )
            .is_empty());
        assert!(host.next_poll_at().is_none());
        assert!(host.poll_due(now + EVIDENCE_POLL_INTERVAL).is_empty());
    }

    #[test]
    fn permission_error_ends_the_evidence_session_without_claiming_audio_changed() {
        let mut host = ControlHost::new(FakeEvidenceFactory {
            source: Some(FakeEvidenceSource {
                polls: VecDeque::from([Err(EvidenceError::PermissionDenied)]),
            }),
        });
        let now = Instant::now();
        let _ = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
                aec_output_route: None,
            },
            now,
        );
        assert!(matches!(
            host.poll_due(now).as_slice(),
            [BridgeEvent::Error {
                code: "accessibility_permission_required",
                ..
            }]
        ));
        assert!(host.next_poll_at().is_none());
    }
}
