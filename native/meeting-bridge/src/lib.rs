//! The native meeting bridge is the only local owner of audio capture and
//! platform evidence. It intentionally contains no ASR, diarization, LLM,
//! Calendar, or renderer-facing PCM protocol.
//!
//! The public contracts here are deliberately small so Electron main can
//! supervise this process without importing audio or Accessibility APIs.

pub mod aec;
pub mod capture;
pub mod evidence;
pub mod protocol;
pub mod types;

pub use aec::{
    AecConfig, AecCoordinator, AecError, AecMetrics, AecOutputRoute, AecProcessor,
    AecReferenceAlignment,
};
pub use capture::{AudioSource, CaptureSupervisor, DualCapture, FrameQueue, SourceError};
pub use evidence::{MeetingEvidenceSource, SpeakerEvidence};
pub use types::{
    AecEngine, AecFrameDisposition, AecFrameMetadata, AecHealth, AecReferenceTiming, AecState,
    AudioFrame, CaptureHealth, CaptureState, Channel,
};
