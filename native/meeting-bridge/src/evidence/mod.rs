//! Bounded, normalized meeting evidence. These contracts carry only platform
//! observations needed for attribution; they never expose raw Accessibility
//! trees, arbitrary window text, Calendar attendees, or contact data.

mod anarlog_ax;

use serde::Serialize;

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
pub use anarlog_ax::MacosZoomAnarlogProvider;
pub use anarlog_ax::{
    normalize_anarlog_inspection, AnarlogAxProvider, AnarlogAxSource, AnarlogInspection,
    AnarlogParticipantStream,
};

/// Origin of the observation. Roster-only data is deliberately distinct from
/// `is_active`; it cannot by itself name a transcript interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    ZoomAx,
    MeetAx,
    TeamsAx,
    /// An Accessibility observation from a platform that has not been granted
    /// a platform-specific trust rule. The resolver must fail closed on it.
    GenericAx,
    BrowserExtension,
    VoiceProfile,
    Correction,
}

/// One bounded platform-surface observation. Adapters report snapshots only;
/// the bridge owns debouncing and is the sole authority that can emit an end
/// edge after a previously validated meeting surface disappears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingSurfaceObservation {
    Active,
    Missing,
    Unknown,
}

/// Normalized platform evidence compatible with Anarlog's `meeting_ax` output.
/// `display_name` is optional because a trustworthy active-speaker signal can
/// still be ambiguous and must fail closed in the identity resolver.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpeakerEvidence {
    pub meeting_id: String,
    pub start_sample: u64,
    pub end_sample: u64,
    pub platform: String,
    pub surface: String,
    pub participant_id: Option<String>,
    pub display_name: Option<String>,
    pub is_self: Option<bool>,
    pub is_active: Option<bool>,
    pub is_muted: Option<bool>,
    pub source: EvidenceSource,
    pub confidence: f32,
    pub observed_at_sample: u64,
    pub signals: Vec<String>,
}

impl SpeakerEvidence {
    pub fn bounded(mut self) -> Self {
        self.platform = bounded_string(&self.platform, 64);
        self.surface = bounded_string(&self.surface, 128);
        self.participant_id = self.participant_id.map(|value| bounded_string(&value, 128));
        self.display_name = self.display_name.map(|value| bounded_string(&value, 256));
        self.confidence = self.confidence.clamp(0.0, 1.0);
        self.signals.truncate(8);
        self.signals = self
            .signals
            .into_iter()
            .map(|signal| bounded_string(&signal, 128))
            .collect();
        self
    }
}

/// A platform adapter that has a bounded poll budget. It never decides that a
/// meeting starts or ends; it may only expose its latest validated surface
/// snapshot for the bridge's independent lifecycle debouncer.
pub trait MeetingEvidenceSource: Send {
    fn source_id(&self) -> &str;
    fn poll(&mut self, max_observations: usize) -> Result<Vec<SpeakerEvidence>, EvidenceError>;
    fn surface_observation(&self) -> MeetingSurfaceObservation {
        MeetingSurfaceObservation::Unknown
    }
}

/// Enforce the bridge privacy/performance boundary even if an adapter regresses.
pub fn poll_bounded(
    source: &mut dyn MeetingEvidenceSource,
    max_observations: usize,
) -> Result<Vec<SpeakerEvidence>, EvidenceError> {
    let mut observations = source.poll(max_observations.min(64))?;
    observations.truncate(max_observations.min(64));
    Ok(observations
        .into_iter()
        .map(SpeakerEvidence::bounded)
        .collect())
}

#[derive(Debug, thiserror::Error)]
pub enum EvidenceError {
    #[error("Accessibility permission is unavailable")]
    PermissionDenied,
    #[error("meeting evidence backend unavailable: {0}")]
    Unavailable(String),
    #[error("meeting evidence backend failed: {0}")]
    Backend(String),
}

fn bounded_string(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        poll_bounded, EvidenceError, EvidenceSource, MeetingEvidenceSource, SpeakerEvidence,
    };

    struct NoisySource;
    impl MeetingEvidenceSource for NoisySource {
        fn source_id(&self) -> &str {
            "noisy"
        }
        fn poll(&mut self, _: usize) -> Result<Vec<SpeakerEvidence>, EvidenceError> {
            Ok((0..100)
                .map(|_| SpeakerEvidence {
                    meeting_id: "m".into(),
                    start_sample: 0,
                    end_sample: 1,
                    platform: "x".repeat(100),
                    surface: "y".repeat(200),
                    participant_id: None,
                    display_name: None,
                    is_self: None,
                    is_active: Some(true),
                    is_muted: None,
                    source: EvidenceSource::ZoomAx,
                    confidence: 5.0,
                    observed_at_sample: 0,
                    signals: vec!["signal".repeat(100); 9],
                })
                .collect())
        }
    }

    #[test]
    fn evidence_source_cannot_exceed_a_bounded_payload() {
        let observations = poll_bounded(&mut NoisySource, 99).expect("observations");
        assert_eq!(observations.len(), 64);
        assert_eq!(observations[0].platform.len(), 64);
        assert_eq!(observations[0].surface.len(), 128);
        assert_eq!(observations[0].signals.len(), 8);
        assert_eq!(observations[0].confidence, 1.0);
    }
}
