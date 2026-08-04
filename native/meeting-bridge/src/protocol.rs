//! Newline-delimited JSON control/events for Electron main <-> bridge.
//!
//! The renderer must only receive projected structured events from Electron
//! main. PCM bytes have no JSON representation in this protocol by design.

use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{
    evidence::{poll_bounded, EvidenceError, MeetingEvidenceSource, SpeakerEvidence},
    types::{AudioFrameMetadata, CaptureHealth},
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
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SpeakerKey {
    participant_id: Option<String>,
    display_name: String,
    is_self: Option<bool>,
}

impl ActiveEvidence {
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
    active_evidence: Option<ActiveEvidence>,
    next_poll_at: Option<Instant>,
}

impl<F: EvidenceSessionFactory> ControlHost<F> {
    fn new(factory: F) -> Self {
        Self {
            factory,
            active_evidence: None,
            next_poll_at: None,
        }
    }

    fn handle(&mut self, command: ControlCommand, now: Instant) -> Vec<BridgeEvent> {
        match command {
            ControlCommand::Ping { request_id } => vec![BridgeEvent::Pong { request_id }],
            ControlCommand::Start { meeting_id } => {
                let Some(source) = self.factory.create(&meeting_id, now) else {
                    return vec![source_configuration_required()];
                };
                self.active_evidence = Some(ActiveEvidence {
                    meeting_id,
                    source,
                    previous_active_points: HashMap::new(),
                });
                // Poll on the next turn rather than from the command handler,
                // so the stdio loop remains the only stdout writer and every
                // AX call has the same bounded scheduling path.
                self.next_poll_at = Some(now);
                Vec::new()
            }
            ControlCommand::Stop { meeting_id } => {
                if self
                    .active_evidence
                    .as_ref()
                    .is_some_and(|active| active.meeting_id == meeting_id)
                {
                    self.active_evidence = None;
                    self.next_poll_at = None;
                    Vec::new()
                } else {
                    vec![BridgeEvent::Error {
                        code: "bridge_not_started",
                        message: "no supervised meeting evidence is active for this meeting".into(),
                    }]
                }
            }
            ControlCommand::Status { meeting_id } => {
                if self
                    .active_evidence
                    .as_ref()
                    .is_some_and(|active| active.meeting_id == meeting_id)
                {
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
        }
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
                    active.consecutive_speaker_events(observations)
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

    use crate::{
        evidence::{EvidenceError, EvidenceSource, MeetingEvidenceSource, SpeakerEvidence},
        protocol::{
            write_event, BridgeEvent, ControlCommand, ControlHost, DisabledEvidenceFactory,
            EvidenceSessionFactory, EVIDENCE_POLL_INTERVAL,
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

    #[test]
    fn disabled_default_start_retains_the_fail_closed_audio_boundary() {
        let mut host = ControlHost::new(DisabledEvidenceFactory);
        let events = host.handle(
            ControlCommand::Start {
                meeting_id: "meeting".into(),
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
