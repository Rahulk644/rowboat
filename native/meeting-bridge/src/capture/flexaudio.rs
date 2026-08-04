//! FlexAudio adapter, compiled only with `--features flexaudio`.
//!
//! The upstream source is MIT and pinned in `Cargo.toml` to
//! `7e41bbd0b03c4f52260926fa0148ca0e0179fda1`. This adapter does not promote
//! upstream's reopen event to bridge readiness: a post-open `AudioChunk` still
//! has to pass through [`CaptureSupervisor`](super::CaptureSupervisor).

use flexaudio::{ChunkFlags, Event, OutputFormat, ProcessMode, SourceKind, Stream, StreamConfig};

use super::{AudioSource, RawAudioChunk, SourceError};
use crate::types::Channel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlexAudioInput {
    Mic {
        device_id: Option<String>,
    },
    System {
        device_id: Option<String>,
        exclude_bridge_process: bool,
    },
    Process {
        meeting_pid: u32,
    },
}

/// Direct FlexAudio source wrapper. It requests exactly 16 kHz / mono / 20 ms
/// output and translates each f32 buffer into the bridge's signed-16-bit frame
/// staging type. It does not mix microphone and system audio.
pub struct FlexAudioSource {
    source_id: String,
    channel: Channel,
    input: FlexAudioInput,
    stream: Option<Stream>,
}

impl FlexAudioSource {
    pub fn new(source_id: impl Into<String>, channel: Channel, input: FlexAudioInput) -> Self {
        Self {
            source_id: source_id.into(),
            channel,
            input,
            stream: None,
        }
    }

    fn config(&self) -> StreamConfig {
        let (kind, device_id, target_pid, mode, exclude_self) = match &self.input {
            FlexAudioInput::Mic { device_id } => (
                SourceKind::Mic,
                device_id.clone(),
                None,
                ProcessMode::Include,
                false,
            ),
            FlexAudioInput::System {
                device_id,
                exclude_bridge_process,
            } => (
                SourceKind::SystemLoopback,
                device_id.clone(),
                None,
                ProcessMode::Include,
                *exclude_bridge_process,
            ),
            FlexAudioInput::Process { meeting_pid } => (
                SourceKind::ProcessLoopback,
                None,
                Some(*meeting_pid),
                ProcessMode::Include,
                false,
            ),
        };
        StreamConfig {
            kind,
            device_id,
            target_pid,
            mode,
            exclude_self,
            output: OutputFormat {
                sample_rate: 16_000,
                channels: 1,
            },
            chunk_ms: 20,
            // 4 seconds; the bridge has an additional, explicit bounded
            // transport queue and will report discontinuity on overflow.
            ring_capacity_chunks: 200,
            ..StreamConfig::default()
        }
    }
}

impl AudioSource for FlexAudioSource {
    fn source_id(&self) -> &str {
        &self.source_id
    }

    fn channel(&self) -> Channel {
        self.channel
    }

    fn open(&mut self) -> Result<(), SourceError> {
        let mut stream = flexaudio::open(self.config()).map_err(map_error)?;
        stream.start().map_err(map_error)?;
        self.stream = Some(stream);
        Ok(())
    }

    fn poll(&mut self) -> Result<Option<RawAudioChunk>, SourceError> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| SourceError::Backend("FlexAudio source was not opened".into()))?;
        if let Some(event) = stream.poll_event() {
            match event {
                Event::PermissionDenied => {
                    return Err(SourceError::PermissionDenied(
                        "FlexAudio permission denied".into(),
                    ));
                }
                Event::DeviceLost => {
                    return Err(SourceError::DeviceUnavailable(
                        "FlexAudio device lost".into(),
                    ));
                }
                Event::Error(reason) => return Err(SourceError::Backend(reason)),
                Event::ChunkDropped { .. } | Event::StreamStalled | Event::StreamRecovered => {}
                _ => {}
            }
        }
        let Some(chunk) = stream.poll_chunk() else {
            return Ok(None);
        };
        if chunk.frames != 320 || chunk.data.len() != 320 {
            return Err(SourceError::Backend(format!(
                "FlexAudio returned {} frames / {} samples; expected 320 mono samples",
                chunk.frames,
                chunk.data.len()
            )));
        }
        let pcm_s16le = chunk
            .data
            .into_iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
            .collect();
        Ok(Some(RawAudioChunk {
            pcm_s16le,
            sample_rate: 16_000,
            start_sample: Some(((chunk.pts_ns.max(0) as u128 * 16_000) / 1_000_000_000) as u64),
            discontinuity: chunk.flags.contains(ChunkFlags::DISCONTINUITY)
                || chunk.dropped_before > 0,
            recovered: chunk.flags.contains(ChunkFlags::RECOVERED),
        }))
    }

    fn close(&mut self) {
        if let Some(mut stream) = self.stream.take() {
            stream.stop();
        }
    }
}

fn map_error(error: flexaudio::Error) -> SourceError {
    let message = error.to_string();
    if message.to_ascii_lowercase().contains("permission") {
        SourceError::PermissionDenied(message)
    } else if message.to_ascii_lowercase().contains("device") {
        SourceError::DeviceUnavailable(message)
    } else {
        SourceError::Backend(message)
    }
}
