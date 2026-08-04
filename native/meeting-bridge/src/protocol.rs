//! Newline-delimited JSON control/events for Electron main <-> bridge.
//!
//! The renderer must only receive projected structured events from Electron
//! main. PCM bytes have no JSON representation in this protocol by design.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::{evidence::SpeakerEvidence, types::AudioFrameMetadata, types::CaptureHealth};

pub const PROTOCOL_VERSION: u32 = 1;

/// Commands accepted from Electron main over a private stdio pipe.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlCommand {
    Ping { request_id: String },
    Start { meeting_id: String },
    Stop { meeting_id: String },
    Status { meeting_id: String },
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
    AudioFrame {
        metadata: AudioFrameMetadata,
    },
    SpeakerEvidence {
        evidence: SpeakerEvidence,
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

/// A small stdio loop used by the standalone binary until Electron main owns
/// source construction. It is useful for protocol/version smoke tests only.
pub fn serve_control_stdio() -> Result<(), ProtocolError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    write_event(
        &mut writer,
        &BridgeEvent::Ready {
            protocol_version: PROTOCOL_VERSION,
        },
    )?;

    for line in stdin.lock().lines() {
        let line = line.map_err(ProtocolError::Io)?;
        let event = match decode_command(&line) {
            Ok(ControlCommand::Ping { request_id }) => BridgeEvent::Pong { request_id },
            Ok(ControlCommand::Start { .. }) => BridgeEvent::Error {
                code: "source_configuration_required",
                message: "Electron main must construct the selected AudioSource; the control protocol never carries device credentials or PCM.".into(),
            },
            Ok(ControlCommand::Stop { .. } | ControlCommand::Status { .. }) => BridgeEvent::Error {
                code: "bridge_not_started",
                message: "no supervised capture has been configured".into(),
            },
            Err(error) => BridgeEvent::Error {
                code: "invalid_command",
                message: error.to_string(),
            },
        };
        write_event(&mut writer, &event)?;
    }
    Ok(())
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
    use crate::{
        protocol::{write_event, BridgeEvent},
        types::{AudioFrame, AudioFrameMetadata, Channel, FrameFlags},
    };

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
}
