use serde::Serialize;

/// The capture channel. Channels are intentionally independent: a quiet
/// system channel must never delay microphone capture, or vice versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Mic,
    System,
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
