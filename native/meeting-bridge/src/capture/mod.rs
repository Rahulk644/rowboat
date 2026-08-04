//! Capture contracts, fixed-frame normalization, bounded buffering, and
//! restart supervision. Backends are deliberately adapters; only this module
//! is allowed to declare a channel `Ready`.

mod queue;
mod source;
mod supervisor;

#[cfg(feature = "flexaudio")]
pub mod flexaudio;

pub use queue::{FrameQueue, QueuePush};
pub use source::{
    AudioSource, CaptureCandidate, ProcessFirstFallback, RawAudioChunk, SourceError,
    SystemSourceFactory,
};
pub use supervisor::{CaptureSupervisor, DualCapture, RecoveryPolicy, SupervisorOutput};
