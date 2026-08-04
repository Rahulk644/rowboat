use std::time::Duration;

use crate::types::Channel;

/// PCM supplied by a platform adapter. A zero-valued (silent) buffer is valid;
/// `None` from [`AudioSource::poll`] means that no callback arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAudioChunk {
    pub pcm_s16le: Vec<i16>,
    pub sample_rate: u32,
    /// Meeting-relative capture position, if the backend can supply one.
    /// FlexAudio's current macOS timestamp is intake-derived, so callers must
    /// treat it as lower confidence until the upstream timestamp patch lands.
    pub start_sample: Option<u64>,
    pub discontinuity: bool,
    pub recovered: bool,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SourceError {
    #[error("unsupported capture capability: {0}")]
    Unsupported(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("capture device unavailable: {0}")]
    DeviceUnavailable(String),
    #[error("capture backend failed: {0}")]
    Backend(String),
}

/// A small pull-based adapter surface. Implementors must not block longer than
/// their caller's polling cadence, must not start an ASR/model process, and
/// must return actual PCM only to the bridge transport.
pub trait AudioSource: Send {
    fn source_id(&self) -> &str;
    fn channel(&self) -> Channel;
    fn open(&mut self) -> Result<(), SourceError>;
    fn poll(&mut self) -> Result<Option<RawAudioChunk>, SourceError>;
    fn close(&mut self);
}

/// A system capture candidate. Process capture is a privacy/precision win, but
/// it is never treated as a guarantee that audio is already flowing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureCandidate {
    Process { meeting_pid: u32 },
    System { exclude_bridge_pid: bool },
}

/// Factory boundary for platform-specific process and global output capture.
/// Windows implementers should select WASAPI process loopback first and macOS
/// implementers should select Core Audio Process Tap first.
pub trait SystemSourceFactory: Send + Sync {
    fn open_process(&self, meeting_pid: u32) -> Result<Box<dyn AudioSource>, SourceError>;
    fn open_system(&self, exclude_bridge_pid: bool) -> Result<Box<dyn AudioSource>, SourceError>;
}

/// Policy only; it makes no claim that either capture API has succeeded. The
/// supervisor decides readiness only after a valid audio buffer is observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessFirstFallback {
    pub retry_process_every: Duration,
}

impl Default for ProcessFirstFallback {
    fn default() -> Self {
        Self {
            retry_process_every: Duration::from_secs(5),
        }
    }
}

impl ProcessFirstFallback {
    pub fn candidates(&self, meeting_pid: Option<u32>) -> Vec<CaptureCandidate> {
        let mut candidates = Vec::with_capacity(2);
        if let Some(meeting_pid) = meeting_pid {
            candidates.push(CaptureCandidate::Process { meeting_pid });
        }
        candidates.push(CaptureCandidate::System {
            exclude_bridge_pid: true,
        });
        candidates
    }

    pub fn select(
        &self,
        factory: &dyn SystemSourceFactory,
        meeting_pid: Option<u32>,
    ) -> Result<(Box<dyn AudioSource>, CaptureCandidate), SourceError> {
        let mut last_error = None;
        for candidate in self.candidates(meeting_pid) {
            let result = match candidate {
                CaptureCandidate::Process { meeting_pid } => factory.open_process(meeting_pid),
                CaptureCandidate::System { exclude_bridge_pid } => {
                    factory.open_system(exclude_bridge_pid)
                }
            };
            match result {
                Ok(source) => return Ok((source, candidate)),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| SourceError::Backend("no capture candidates".into())))
    }
}
