use serde::Serialize;

/// The capture channel. Channels are intentionally independent: a quiet
/// system channel must never delay microphone capture, or vice versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Mic,
    System,
}

/// The independently selectable acoustic echo cancellation implementation.
///
/// These names describe a qualified implementation selected by the native
/// host.  They do not imply that an arbitrary Cargo feature, model file, or
/// platform library is available at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AecEngine {
    LocalVqe,
    WebRtcAec3,
}

/// How a microphone frame reached the ASR/VAD transport.  The bridge never
/// drops a microphone frame merely because a render reference is present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AecFrameDisposition {
    /// A configured implementation produced a cleaned microphone frame.
    Cleaned,
    /// A headset or other isolated route made AEC unnecessary.
    BypassedIsolatedOutput,
    /// AEC is intentionally not selected for this session.
    BypassedDisabled,
    /// The reference was missing, stale, or not timestamp-qualified.  The raw
    /// microphone frame was passed through to preserve near-end speech.
    BypassedReferenceUnavailable,
    /// The implementation rejected a frame.  The raw microphone frame was
    /// passed through and the session entered a degraded health state.
    BypassedProcessorFailure,
    /// A source discontinuity invalidated alignment.  The raw microphone
    /// frame was passed through and alignment must be re-established.
    BypassedDiscontinuity,
}

/// Reference timing provenance.  This is metadata only; it never includes a
/// device identifier, source title, PCM, or user content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AecReferenceTiming {
    NotUsed,
    Trusted,
    Untrusted,
    Missing,
}

/// Per-microphone-frame AEC provenance.  It is included in frame metadata so
/// Electron main can make speaker-attribution decisions without inspecting
/// PCM or inferring quality from a UI state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AecFrameMetadata {
    pub engine: Option<AecEngine>,
    pub disposition: AecFrameDisposition,
    pub reference_timing: AecReferenceTiming,
    /// The accepted render-reference position minus the microphone position.
    /// This is a bounded integer sample delta, never an audio payload.
    pub reference_offset_samples: Option<i64>,
}

/// Session-level AEC lifecycle.  `Ready` means a configured implementation
/// has processed at least one timestamp-qualified mic/render pair; it is not a
/// claim that a physical echo-quality gate has passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AecState {
    Off,
    Bypassed,
    WaitingForReference,
    Ready,
    Degraded,
}

/// Bounded, privacy-safe AEC health.  This deliberately contains counts and
/// state only; no PCM, transcript text, device name, model path, or metric
/// derived from a user's speech is emitted here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AecHealth {
    pub meeting_id: String,
    pub engine: Option<AecEngine>,
    pub state: AecState,
    pub processed_frames: u64,
    pub raw_bypass_frames: u64,
    pub reference_missing_frames: u64,
    pub processor_failure_frames: u64,
    pub reference_evictions: u64,
    pub pending_mic_frames: usize,
    pub reason: Option<String>,
}

impl AecHealth {
    pub(crate) fn new(meeting_id: impl Into<String>, engine: Option<AecEngine>) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            engine,
            state: AecState::Off,
            processed_frames: 0,
            raw_bypass_frames: 0,
            reference_missing_frames: 0,
            processor_failure_frames: 0,
            reference_evictions: 0,
            pending_mic_frames: 0,
            reason: None,
        }
    }
}

/// Flags which make audio gaps visible to downstream ASR and transcript
/// revision logic. They are never inferred from transcript text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FrameFlags {
    pub discontinuity: bool,
    pub recovered: bool,
    pub silence: bool,
}

impl FrameFlags {
    pub fn with_discontinuity(recovered: bool) -> Self {
        Self {
            discontinuity: true,
            recovered,
            silence: false,
        }
    }
}

/// A fixed 20 ms mono signed-16-bit frame for the private bridge-to-service
/// transport. This type deliberately does not implement `Serialize`: audio is
/// passed to the VPS transport directly, never base64 encoded through renderer
/// IPC or emitted on the bridge's NDJSON control stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioFrame {
    pub meeting_id: String,
    pub source_id: String,
    pub channel: Channel,
    pub start_sample: u64,
    pub sample_count: u32,
    pub sample_rate: u32,
    pub sequence: u64,
    pub epoch: u64,
    pub flags: FrameFlags,
    /// AEC provenance for microphone frames.  System frames and raw capture
    /// frames leave this as `None` until an AEC coordinator processes them.
    pub aec: Option<AecFrameMetadata>,
    pub pcm_s16le: Vec<i16>,
}

/// The metadata version of an [`AudioFrame`], safe to emit over NDJSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioFrameMetadata {
    pub meeting_id: String,
    pub source_id: String,
    pub channel: Channel,
    pub start_sample: u64,
    pub sample_count: u32,
    pub sample_rate: u32,
    pub sequence: u64,
    pub epoch: u64,
    pub flags: FrameFlags,
    pub aec: Option<AecFrameMetadata>,
}

impl From<&AudioFrame> for AudioFrameMetadata {
    fn from(frame: &AudioFrame) -> Self {
        Self {
            meeting_id: frame.meeting_id.clone(),
            source_id: frame.source_id.clone(),
            channel: frame.channel,
            start_sample: frame.start_sample,
            sample_count: frame.sample_count,
            sample_rate: frame.sample_rate,
            sequence: frame.sequence,
            epoch: frame.epoch,
            flags: frame.flags,
            aec: frame.aec.clone(),
        }
    }
}

/// Observable lifecycle state. `Ready` means a valid post-open audio buffer
/// was received; an open OS handle alone can never yield `Ready`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Off,
    Starting,
    Ready,
    Stalled,
    Recovering,
    Failed,
}

/// A bounded reason suitable for UI and telemetry. Never put transcript text,
/// Accessibility trees, device serials, or credentials in this field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaptureHealth {
    pub meeting_id: String,
    pub channel: Channel,
    pub state: CaptureState,
    pub sequence: u64,
    pub last_frame_sample: Option<u64>,
    pub restart_count: u32,
    pub reason: Option<String>,
}

impl CaptureHealth {
    pub(crate) fn new(meeting_id: impl Into<String>, channel: Channel) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            channel,
            state: CaptureState::Off,
            sequence: 0,
            last_frame_sample: None,
            restart_count: 0,
            reason: None,
        }
    }
}
