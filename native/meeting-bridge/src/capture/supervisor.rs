use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use crate::{
    capture::{AudioSource, FrameQueue, RawAudioChunk, SourceError},
    types::{AudioFrame, CaptureHealth, CaptureState, Channel, FrameFlags},
};

const FRAME_MS: u32 = 20;

/// Recovery limits are intentionally small and deterministic. Electron main is
/// expected to recycle the entire sidecar after `Failed`, rather than letting a
/// permanently wedged native backend leak resources inside the app process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryPolicy {
    pub stall_after: Duration,
    pub initial_backoff: Duration,
    pub maximum_backoff: Duration,
    pub maximum_failed_recoveries: usize,
    pub recovery_window: Duration,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            stall_after: Duration::from_secs(2),
            initial_backoff: Duration::from_millis(250),
            maximum_backoff: Duration::from_secs(5),
            maximum_failed_recoveries: 3,
            recovery_window: Duration::from_secs(60),
        }
    }
}

/// The result of one non-blocking supervisor tick.
#[derive(Debug, Default)]
pub struct SupervisorOutput {
    pub frames: Vec<AudioFrame>,
    pub health: Vec<CaptureHealth>,
}

/// A supervised single-channel source. It requires a non-empty valid post-open
/// PCM callback before emitting `Ready`; a silent PCM buffer is valid.
pub struct CaptureSupervisor {
    source: Box<dyn AudioSource>,
    policy: RecoveryPolicy,
    health: CaptureHealth,
    framer: FrameFramer,
    opened_at: Option<Instant>,
    last_callback_at: Option<Instant>,
    next_reopen_at: Option<Instant>,
    failed_recoveries: VecDeque<Instant>,
    post_reopen_pending: bool,
}

impl CaptureSupervisor {
    pub fn new(
        meeting_id: impl Into<String>,
        source: Box<dyn AudioSource>,
        sample_rate: u32,
        policy: RecoveryPolicy,
    ) -> Result<Self, SourceError> {
        if sample_rate == 0 || (sample_rate as u64 * FRAME_MS as u64) % 1_000 != 0 {
            return Err(SourceError::Unsupported(
                "sample rate must contain an integral 20 ms frame".into(),
            ));
        }
        let meeting_id = meeting_id.into();
        let channel = source.channel();
        Ok(Self {
            health: CaptureHealth::new(meeting_id.clone(), channel),
            framer: FrameFramer::new(
                meeting_id.clone(),
                source.source_id().to_owned(),
                channel,
                sample_rate,
            ),
            source,
            policy,
            opened_at: None,
            last_callback_at: None,
            next_reopen_at: None,
            failed_recoveries: VecDeque::new(),
            post_reopen_pending: false,
        })
    }

    pub fn channel(&self) -> Channel {
        self.health.channel
    }

    pub fn health(&self) -> &CaptureHealth {
        &self.health
    }

    /// Initial open. This transitions only to `Starting`; it intentionally
    /// does not call the channel healthy until a valid frame arrives.
    pub fn start(&mut self, now: Instant) -> SupervisorOutput {
        let mut output = SupervisorOutput::default();
        if self.health.state != CaptureState::Off {
            return output;
        }
        self.transition(CaptureState::Starting, None, &mut output);
        match self.source.open() {
            Ok(()) => {
                self.opened_at = Some(now);
                self.last_callback_at = None;
            }
            Err(error) => self.schedule_recovery(now, error.to_string(), &mut output),
        }
        output
    }

    /// Poll once. The host can call both channel supervisors in a round-robin
    /// loop; neither path waits for the other channel to become ready.
    pub fn tick(&mut self, now: Instant) -> SupervisorOutput {
        let mut output = SupervisorOutput::default();
        match self.health.state {
            CaptureState::Off | CaptureState::Failed => return output,
            CaptureState::Recovering => {
                if self.opened_at.is_none() {
                    let retry_due = self.next_reopen_at.is_none_or(|at| now >= at);
                    if retry_due {
                        self.try_reopen(now, &mut output);
                    } else {
                        return output;
                    }
                }
            }
            CaptureState::Starting | CaptureState::Ready | CaptureState::Stalled => {}
        }

        if matches!(self.health.state, CaptureState::Failed | CaptureState::Off) {
            return output;
        }

        match self.source.poll() {
            Ok(Some(chunk)) => self.on_chunk(now, chunk, &mut output),
            Ok(None) => self.on_no_callback(now, &mut output),
            Err(error) => self.on_source_error(now, error, &mut output),
        }
        output
    }

    pub fn stop(&mut self) -> SupervisorOutput {
        let mut output = SupervisorOutput::default();
        self.source.close();
        self.opened_at = None;
        self.next_reopen_at = None;
        self.transition(CaptureState::Off, None, &mut output);
        output
    }

    fn on_chunk(&mut self, now: Instant, chunk: RawAudioChunk, output: &mut SupervisorOutput) {
        if chunk.pcm_s16le.is_empty() {
            self.on_source_error(
                now,
                SourceError::Backend("backend emitted an empty audio callback".into()),
                output,
            );
            return;
        }

        self.last_callback_at = Some(now);
        let recovered = self.post_reopen_pending;
        if recovered {
            self.framer.mark_discontinuity(true);
            self.post_reopen_pending = false;
        }
        if chunk.discontinuity && !recovered {
            self.framer.mark_discontinuity(chunk.recovered);
        }

        match self.framer.push(chunk) {
            Ok(frames) => {
                if !frames.is_empty() && self.health.state != CaptureState::Ready {
                    self.transition(CaptureState::Ready, None, output);
                }
                if let Some(last) = frames.last() {
                    self.health.sequence = last.sequence;
                    self.health.last_frame_sample = Some(last.start_sample);
                }
                output.frames.extend(frames);
            }
            Err(error) => self.on_source_error(now, error, output),
        }
    }

    fn on_no_callback(&mut self, now: Instant, output: &mut SupervisorOutput) {
        let observed_at = self.last_callback_at.or(self.opened_at);
        if observed_at.is_some_and(|last| now.duration_since(last) >= self.policy.stall_after) {
            if self.health.state == CaptureState::Recovering {
                self.failed_recovery(now, "post-open callback timeout".into(), output);
            } else {
                self.transition(
                    CaptureState::Stalled,
                    Some("no audio callback within stall threshold".into()),
                    output,
                );
                self.schedule_recovery(now, "capture callback stalled".into(), output);
            }
        }
    }

    fn on_source_error(&mut self, now: Instant, error: SourceError, output: &mut SupervisorOutput) {
        if self.health.state == CaptureState::Recovering {
            self.failed_recovery(now, error.to_string(), output);
        } else {
            self.transition(CaptureState::Stalled, Some(error.to_string()), output);
            self.schedule_recovery(now, error.to_string(), output);
        }
    }

    fn schedule_recovery(&mut self, now: Instant, reason: String, output: &mut SupervisorOutput) {
        self.source.close();
        self.opened_at = None;
        self.last_callback_at = None;
        self.next_reopen_at = Some(now + self.current_backoff());
        self.transition(CaptureState::Recovering, Some(reason), output);
    }

    fn try_reopen(&mut self, now: Instant, output: &mut SupervisorOutput) {
        self.health.restart_count = self.health.restart_count.saturating_add(1);
        match self.source.open() {
            Ok(()) => {
                self.opened_at = Some(now);
                self.last_callback_at = None;
                self.next_reopen_at = None;
                // Still `Recovering` until a real PCM buffer makes it through
                // the adapter and normalizer.
                self.post_reopen_pending = true;
            }
            Err(error) => self.failed_recovery(now, error.to_string(), output),
        }
    }

    fn failed_recovery(&mut self, now: Instant, reason: String, output: &mut SupervisorOutput) {
        self.source.close();
        self.opened_at = None;
        self.last_callback_at = None;
        self.post_reopen_pending = false;
        self.failed_recoveries.push_back(now);
        while self
            .failed_recoveries
            .front()
            .is_some_and(|at| now.duration_since(*at) > self.policy.recovery_window)
        {
            let _ = self.failed_recoveries.pop_front();
        }
        if self.failed_recoveries.len() >= self.policy.maximum_failed_recoveries {
            self.transition(
                CaptureState::Failed,
                Some(format!("{reason}; recovery limit reached")),
                output,
            );
        } else {
            self.next_reopen_at = Some(now + self.current_backoff());
            self.transition(CaptureState::Recovering, Some(reason), output);
        }
    }

    fn current_backoff(&self) -> Duration {
        let exponent = self.health.restart_count.min(5);
        let multiplier = 1_u32 << exponent;
        self.policy
            .initial_backoff
            .saturating_mul(multiplier)
            .min(self.policy.maximum_backoff)
    }

    fn transition(
        &mut self,
        state: CaptureState,
        reason: Option<String>,
        output: &mut SupervisorOutput,
    ) {
        if self.health.state == state && self.health.reason == reason {
            return;
        }
        self.health.state = state;
        self.health.reason = reason.map(|reason| bounded_reason(&reason));
        output.health.push(self.health.clone());
    }
}

fn bounded_reason(reason: &str) -> String {
    const MAX_REASON_BYTES: usize = 240;
    if reason.len() <= MAX_REASON_BYTES {
        return reason.to_owned();
    }
    let mut end = MAX_REASON_BYTES;
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &reason[..end])
}

/// Fixed-size mono framing and sample-clock ownership. The frame sequence is
/// per channel; `start_sample` uses a meeting-relative source clock when one is
/// available and still makes every discontinuity/epoch explicit when it is not.
#[derive(Debug)]
struct FrameFramer {
    meeting_id: String,
    source_id: String,
    channel: Channel,
    sample_rate: u32,
    samples_per_frame: usize,
    pending: VecDeque<i16>,
    pending_start_sample: Option<u64>,
    expected_next_sample: Option<u64>,
    next_sequence: u64,
    epoch: u64,
    next_flags: FrameFlags,
}

impl FrameFramer {
    fn new(meeting_id: String, source_id: String, channel: Channel, sample_rate: u32) -> Self {
        Self {
            meeting_id,
            source_id,
            channel,
            sample_rate,
            samples_per_frame: (sample_rate as usize * FRAME_MS as usize) / 1_000,
            pending: VecDeque::new(),
            pending_start_sample: None,
            expected_next_sample: None,
            next_sequence: 0,
            epoch: 0,
            next_flags: FrameFlags::default(),
        }
    }

    fn mark_discontinuity(&mut self, recovered: bool) {
        self.pending.clear();
        self.pending_start_sample = None;
        self.expected_next_sample = None;
        self.epoch = self.epoch.saturating_add(1);
        self.next_flags = FrameFlags::with_discontinuity(recovered);
    }

    fn push(&mut self, chunk: RawAudioChunk) -> Result<Vec<AudioFrame>, SourceError> {
        if chunk.sample_rate != self.sample_rate {
            return Err(SourceError::Unsupported(format!(
                "{} Hz source does not match the configured {} Hz bridge clock",
                chunk.sample_rate, self.sample_rate
            )));
        }
        let incoming_start = chunk
            .start_sample
            .or(self.expected_next_sample)
            .unwrap_or(0);
        if let Some(expected) = self.expected_next_sample {
            if incoming_start != expected {
                self.mark_discontinuity(false);
            }
        }
        if self.pending.is_empty() {
            self.pending_start_sample = Some(incoming_start);
        }
        self.expected_next_sample =
            Some(incoming_start.saturating_add(chunk.pcm_s16le.len() as u64));
        self.pending.extend(chunk.pcm_s16le);

        let mut frames = Vec::new();
        while self.pending.len() >= self.samples_per_frame {
            let start_sample = self.pending_start_sample.unwrap_or(incoming_start);
            let pcm_s16le = self
                .pending
                .drain(..self.samples_per_frame)
                .collect::<Vec<_>>();
            self.pending_start_sample = if self.pending.is_empty() {
                None
            } else {
                Some(start_sample.saturating_add(self.samples_per_frame as u64))
            };
            let mut flags = std::mem::take(&mut self.next_flags);
            flags.silence = pcm_s16le.iter().all(|sample| *sample == 0);
            frames.push(AudioFrame {
                meeting_id: self.meeting_id.clone(),
                source_id: self.source_id.clone(),
                channel: self.channel,
                start_sample,
                sample_count: self.samples_per_frame as u32,
                sample_rate: self.sample_rate,
                sequence: self.next_sequence,
                epoch: self.epoch,
                flags,
                pcm_s16le,
            });
            self.next_sequence = self.next_sequence.saturating_add(1);
        }
        Ok(frames)
    }
}

/// Two completely independent source supervisors plus bounded transport queues.
/// This is the explicit guard against the historic "remote must speak first"
/// failure: both `start` calls happen before any frame is awaited.
pub struct DualCapture {
    pub mic: CaptureSupervisor,
    pub system: CaptureSupervisor,
    mic_queue: FrameQueue,
    system_queue: FrameQueue,
}

#[derive(Debug, Default)]
pub struct DualCaptureOutput {
    pub health: Vec<CaptureHealth>,
    pub backpressure: Vec<(Channel, u64, usize)>,
}

impl DualCapture {
    pub fn new(
        mic: CaptureSupervisor,
        system: CaptureSupervisor,
        queue_capacity_frames: usize,
    ) -> Result<Self, SourceError> {
        if mic.channel() != Channel::Mic || system.channel() != Channel::System {
            return Err(SourceError::Backend(
                "DualCapture requires a mic source and a system source".into(),
            ));
        }
        Ok(Self {
            mic,
            system,
            mic_queue: FrameQueue::new(queue_capacity_frames),
            system_queue: FrameQueue::new(queue_capacity_frames),
        })
    }

    pub fn start(&mut self, now: Instant) -> DualCaptureOutput {
        let mic = self.mic.start(now);
        let system = self.system.start(now);
        let output = self.consume_output(mic, Channel::Mic, DualCaptureOutput::default());
        self.consume_output(system, Channel::System, output)
    }

    pub fn tick(&mut self, now: Instant) -> DualCaptureOutput {
        let mic = self.mic.tick(now);
        let system = self.system.tick(now);
        let output = self.consume_output(mic, Channel::Mic, DualCaptureOutput::default());
        self.consume_output(system, Channel::System, output)
    }

    pub fn pop_mic_frame(&mut self) -> Option<AudioFrame> {
        self.mic_queue.pop()
    }

    pub fn pop_system_frame(&mut self) -> Option<AudioFrame> {
        self.system_queue.pop()
    }

    pub fn queue_len(&self, channel: Channel) -> usize {
        match channel {
            Channel::Mic => self.mic_queue.len(),
            Channel::System => self.system_queue.len(),
        }
    }

    fn consume_output(
        &mut self,
        output: SupervisorOutput,
        channel: Channel,
        mut aggregate: DualCaptureOutput,
    ) -> DualCaptureOutput {
        aggregate.health.extend(output.health);
        let queue = match channel {
            Channel::Mic => &mut self.mic_queue,
            Channel::System => &mut self.system_queue,
        };
        for frame in output.frames {
            let report = queue.push(frame);
            if report.dropped_oldest {
                aggregate
                    .backpressure
                    .push((channel, report.dropped_total, report.capacity));
            }
        }
        aggregate
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use crate::{capture::RawAudioChunk, types::CaptureState};

    use super::{
        AudioSource, CaptureSupervisor, Channel, DualCapture, RecoveryPolicy, SourceError,
    };

    #[derive(Debug, Default)]
    struct MockState {
        opens: usize,
        chunks: VecDeque<Result<Option<RawAudioChunk>, SourceError>>,
    }

    #[derive(Debug)]
    struct MockSource {
        id: &'static str,
        channel: Channel,
        state: Arc<Mutex<MockState>>,
        open_results: VecDeque<Result<(), SourceError>>,
    }

    impl MockSource {
        fn new(channel: Channel, state: Arc<Mutex<MockState>>) -> Self {
            Self {
                id: match channel {
                    Channel::Mic => "mock-mic",
                    Channel::System => "mock-system",
                },
                channel,
                state,
                open_results: VecDeque::new(),
            }
        }
    }

    impl AudioSource for MockSource {
        fn source_id(&self) -> &str {
            self.id
        }
        fn channel(&self) -> Channel {
            self.channel
        }
        fn open(&mut self) -> Result<(), SourceError> {
            self.state.lock().expect("state").opens += 1;
            self.open_results.pop_front().unwrap_or(Ok(()))
        }
        fn poll(&mut self) -> Result<Option<RawAudioChunk>, SourceError> {
            self.state
                .lock()
                .expect("state")
                .chunks
                .pop_front()
                .unwrap_or(Ok(None))
        }
        fn close(&mut self) {}
    }

    fn pcm(start_sample: u64, value: i16) -> RawAudioChunk {
        RawAudioChunk {
            pcm_s16le: vec![value; 320],
            sample_rate: 16_000,
            start_sample: Some(start_sample),
            discontinuity: false,
            recovered: false,
        }
    }

    fn policy() -> RecoveryPolicy {
        RecoveryPolicy {
            stall_after: Duration::from_millis(20),
            initial_backoff: Duration::from_millis(1),
            maximum_backoff: Duration::from_millis(5),
            ..RecoveryPolicy::default()
        }
    }

    #[test]
    fn local_first_recording_does_not_wait_for_silent_system_audio() {
        let mic_state = Arc::new(Mutex::new(MockState::default()));
        let system_state = Arc::new(Mutex::new(MockState::default()));
        mic_state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(0, 123))));

        let mic = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::Mic, mic_state)),
            16_000,
            policy(),
        )
        .expect("mic");
        let system = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::System, system_state)),
            16_000,
            policy(),
        )
        .expect("system");
        let mut capture = DualCapture::new(mic, system, 4).expect("dual");
        let now = std::time::Instant::now();
        let _ = capture.start(now);
        let _ = capture.tick(now);

        assert_eq!(capture.mic.health().state, CaptureState::Ready);
        assert_eq!(capture.system.health().state, CaptureState::Starting);
        assert_eq!(
            capture.pop_mic_frame().expect("local frame").start_sample,
            0
        );
        assert!(capture.pop_system_frame().is_none());
    }

    #[test]
    fn remote_first_readiness_is_independent_of_microphone() {
        let mic_state = Arc::new(Mutex::new(MockState::default()));
        let system_state = Arc::new(Mutex::new(MockState::default()));
        system_state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(0, 99))));

        let mic = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::Mic, mic_state)),
            16_000,
            policy(),
        )
        .expect("mic");
        let system = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::System, system_state)),
            16_000,
            policy(),
        )
        .expect("system");
        let mut capture = DualCapture::new(mic, system, 4).expect("dual");
        let now = std::time::Instant::now();
        let _ = capture.start(now);
        let _ = capture.tick(now);

        assert_eq!(capture.mic.health().state, CaptureState::Starting);
        assert_eq!(capture.system.health().state, CaptureState::Ready);
        assert!(capture.pop_mic_frame().is_none());
        assert_eq!(
            capture.pop_system_frame().expect("remote frame").channel,
            Channel::System
        );
    }

    #[test]
    fn silent_system_callback_is_healthy_and_does_not_delay_local_capture() {
        let mic_state = Arc::new(Mutex::new(MockState::default()));
        let system_state = Arc::new(Mutex::new(MockState::default()));
        mic_state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(0, 4))));
        // A zero-value callback represents a real, silent remote output. It
        // must count as ready; the absence of callbacks is the stall case.
        system_state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(0, 0))));

        let mic = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::Mic, mic_state)),
            16_000,
            policy(),
        )
        .expect("mic");
        let system = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::System, system_state)),
            16_000,
            policy(),
        )
        .expect("system");
        let mut capture = DualCapture::new(mic, system, 4).expect("dual");
        let now = std::time::Instant::now();
        let _ = capture.start(now);
        let _ = capture.tick(now);

        assert_eq!(capture.mic.health().state, CaptureState::Ready);
        assert_eq!(capture.system.health().state, CaptureState::Ready);
        assert!(
            capture
                .pop_system_frame()
                .expect("silent system frame")
                .flags
                .silence
        );
    }

    #[test]
    fn recovery_requires_the_first_post_open_audio_buffer() {
        let state = Arc::new(Mutex::new(MockState::default()));
        state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(0, 1))));
        let mut supervisor = CaptureSupervisor::new(
            "meeting",
            Box::new(MockSource::new(Channel::Mic, state.clone())),
            16_000,
            policy(),
        )
        .expect("supervisor");
        let now = std::time::Instant::now();
        let _ = supervisor.start(now);
        let _ = supervisor.tick(now);
        assert_eq!(supervisor.health().state, CaptureState::Ready);

        let after_stall = now + Duration::from_millis(25);
        let stalled = supervisor.tick(after_stall);
        assert!(stalled
            .health
            .iter()
            .any(|health| health.state == CaptureState::Stalled));
        assert_eq!(supervisor.health().state, CaptureState::Recovering);

        let after_reopen = after_stall + Duration::from_millis(2);
        let _ = supervisor.tick(after_reopen);
        assert_eq!(
            supervisor.health().state,
            CaptureState::Recovering,
            "open handle is not ready"
        );

        state
            .lock()
            .expect("state")
            .chunks
            .push_back(Ok(Some(pcm(320, 2))));
        let recovered = supervisor.tick(after_reopen + Duration::from_millis(1));
        let frame = recovered.frames.first().expect("recovered frame");
        assert_eq!(supervisor.health().state, CaptureState::Ready);
        assert!(frame.flags.discontinuity);
        assert!(frame.flags.recovered);
        assert_eq!(frame.epoch, 1);
    }
}
