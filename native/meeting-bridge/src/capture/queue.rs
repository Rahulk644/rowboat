use std::collections::VecDeque;

use crate::types::AudioFrame;

/// A bounded, non-blocking queue between capture and private VPS transport.
/// Capturing must not wait for a slow network. On overflow the oldest audio is
/// dropped and the *next dequeued surviving frame* is marked discontinuous.
#[derive(Debug)]
pub struct FrameQueue {
    capacity: usize,
    frames: VecDeque<AudioFrame>,
    dropped_frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueuePush {
    pub dropped_oldest: bool,
    pub dropped_total: u64,
    pub capacity: usize,
}

impl FrameQueue {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "frame queue capacity must be non-zero");
        Self {
            capacity,
            frames: VecDeque::with_capacity(capacity),
            dropped_frames: 0,
        }
    }

    pub fn push(&mut self, mut frame: AudioFrame) -> QueuePush {
        let dropped_oldest = self.frames.len() == self.capacity;
        if dropped_oldest {
            let _ = self.frames.pop_front();
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            if let Some(next_surviving) = self.frames.front_mut() {
                // The next consumer-visible frame is after the missing audio.
                next_surviving.flags.discontinuity = true;
            } else {
                // Capacity one: the newly pushed frame is next visible.
                frame.flags.discontinuity = true;
            }
        }
        self.frames.push_back(frame);
        QueuePush {
            dropped_oldest,
            dropped_total: self.dropped_frames,
            capacity: self.capacity,
        }
    }

    pub fn pop(&mut self) -> Option<AudioFrame> {
        self.frames.pop_front()
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }
}

#[cfg(test)]
mod tests {
    use crate::types::{AudioFrame, Channel, FrameFlags};

    use super::FrameQueue;

    fn frame(sequence: u64) -> AudioFrame {
        AudioFrame {
            meeting_id: "m".into(),
            source_id: "source".into(),
            channel: Channel::Mic,
            start_sample: sequence * 320,
            sample_count: 320,
            sample_rate: 16_000,
            sequence,
            epoch: 0,
            flags: FrameFlags::default(),
            aec: None,
            pcm_s16le: vec![0; 320],
        }
    }

    #[test]
    fn overflow_marks_the_next_surviving_frame_not_the_tail() {
        let mut queue = FrameQueue::new(3);
        let _ = queue.push(frame(0));
        let _ = queue.push(frame(1));
        let _ = queue.push(frame(2));
        let _ = queue.pop().expect("prior consumer frame");
        let _ = queue.push(frame(3));
        let report = queue.push(frame(4));

        assert!(report.dropped_oldest);
        assert_eq!(report.dropped_total, 1);
        let next = queue.pop().expect("next surviving frame");
        assert_eq!(next.sequence, 2);
        assert!(next.flags.discontinuity);
        assert!(!queue.pop().expect("tail frame").flags.discontinuity);
    }
}
