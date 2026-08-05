//! Optional WebRTC AEC3 comparator.
//!
//! This adapter uses the stable `webrtc-audio-processing` 2.1.0 wrapper pinned
//! to audited commit `c14d7af1760baff83e8210fee336a0cae0faaa7d` (PulseAudio
//! WebRTC submodule `d0569cfa`). Its native AudioProcessing API
//! operates on 10 ms, 160-sample mono frames at 16 kHz, so callers must wrap
//! it in [`super::StreamingReblocker`]. The package is BSD-3-Clause and, by
//! bundles the pinned reviewed C++ source only when this feature is selected;
//! it never resolves an arbitrary OS-provided library at runtime.

use webrtc_audio_processing::{config::EchoCanceller, Config, Processor};

use super::{AecError, AecHopProcessor, AecProcessor, StreamingReblocker};
use crate::types::AecEngine;

pub const WEBRTC_AUDIO_PROCESSING_VERSION: &str = "2.1.0";
pub const WEBRTC_AUDIO_PROCESSING_UPSTREAM_REVISION: &str =
    "c14d7af1760baff83e8210fee336a0cae0faaa7d";
pub const WEBRTC_PULSEAUDIO_SUBMODULE_REVISION: &str = "d0569cfa";
pub const WEBRTC_AEC3_SAMPLE_RATE_HZ: u32 = 16_000;
pub const WEBRTC_AEC3_HOP_SAMPLES: usize = 160;

/// One stateful mono AEC3 processor. Rendering is analyzed before the paired
/// capture frame, exactly once per aligned 10 ms hop.
pub struct WebRtcAec3HopProcessor {
    processor: Processor,
}

impl WebRtcAec3HopProcessor {
    pub fn new() -> Result<Self, AecError> {
        let processor = Processor::new(WEBRTC_AEC3_SAMPLE_RATE_HZ).map_err(|_| {
            AecError::BindingUnavailable {
                engine: AecEngine::WebRtcAec3,
            }
        })?;
        processor.set_config(Config {
            // Leave stream delay estimation enabled. The bridge's trusted
            // render/mic timestamp alignment is the external admission gate;
            // inventing a millisecond delay here would create a second,
            // conflicting timing authority.
            echo_canceller: Some(EchoCanceller::Full {
                stream_delay_ms: None,
            }),
            ..Config::default()
        });
        Ok(Self { processor })
    }
}

impl AecHopProcessor for WebRtcAec3HopProcessor {
    fn engine(&self) -> AecEngine {
        AecEngine::WebRtcAec3
    }

    fn hop_samples(&self) -> usize {
        WEBRTC_AEC3_HOP_SAMPLES
    }

    fn process_hop(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError> {
        if render_pcm_s16le.len() != WEBRTC_AEC3_HOP_SAMPLES
            || mic_pcm_s16le.len() != WEBRTC_AEC3_HOP_SAMPLES
        {
            return Err(AecError::InvalidFrame);
        }
        let render = render_pcm_s16le
            .iter()
            .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
            .collect::<Vec<_>>();
        let mut capture = mic_pcm_s16le
            .iter()
            .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
            .collect::<Vec<_>>();
        self.processor
            .analyze_render_frame([render.as_slice()])
            .and_then(|()| {
                self.processor
                    .process_capture_frame([capture.as_mut_slice()])
            })
            .map_err(|_| AecError::Processor {
                engine: AecEngine::WebRtcAec3,
                message: "WebRTC AEC3 processing failed".into(),
            })?;
        Ok(capture
            .into_iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16)
            .collect())
    }

    fn reset(&mut self) {
        self.processor.reinitialize();
    }
}

pub fn build_aec_processor() -> Result<Box<dyn AecProcessor>, AecError> {
    Ok(Box::new(StreamingReblocker::new(
        WebRtcAec3HopProcessor::new()?,
    )))
}

#[cfg(test)]
mod tests {
    use super::{WebRtcAec3HopProcessor, WEBRTC_AEC3_HOP_SAMPLES};
    use crate::aec::AecHopProcessor;

    #[test]
    fn aec3_accepts_one_aligned_silent_ten_millisecond_hop() {
        let mut processor = WebRtcAec3HopProcessor::new().expect("bundled AEC3 processor");
        let output = processor
            .process_hop(
                &vec![0; WEBRTC_AEC3_HOP_SAMPLES],
                &vec![0; WEBRTC_AEC3_HOP_SAMPLES],
            )
            .expect("AEC3 silent hop");
        assert_eq!(output.len(), WEBRTC_AEC3_HOP_SAMPLES);
    }
}
