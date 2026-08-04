//! Compatibility boundary for Anarlog's MIT `meeting_ax` module.
//!
//! We do not fabricate Accessibility evidence. The actual macOS provider is
//! left outside this crate until its pinned, workspace-coupled module is
//! vendored with notices and qualified against a real TCC-enabled Zoom/Meet
//! session. This file preserves the exact bounded translation shape so that
//! vendor/wrapper work cannot accidentally leak an AX tree into Rowboat.

use super::{EvidenceError, EvidenceSource, MeetingEvidenceSource, SpeakerEvidence};

/// The fields the bridge accepts from Anarlog's participant stream. Screen
/// bounds are intentionally excluded: Rowboat needs evidence, not layout.
#[derive(Debug, Clone, PartialEq)]
pub struct AnarlogParticipantStream {
    pub participant_id: Option<String>,
    pub participant_name: Option<String>,
    pub is_self: Option<bool>,
    pub is_active_speaker: Option<bool>,
    pub is_muted: Option<bool>,
    pub confidence: f32,
    pub signals: Vec<String>,
}

/// A bounded snapshot corresponding to an Anarlog `MeetingAccessibilityInspection`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnarlogInspection {
    pub platform: String,
    pub surface: String,
    pub observed_at_sample: u64,
    pub active_speakers: Vec<AnarlogParticipantStream>,
}

/// Minimal provider needed by the adapter. A production implementation must
/// call the audited Anarlog module and must use its own bounded AX traversal;
/// it cannot substitute browser title text or a Calendar participant list.
pub trait AnarlogAxProvider: Send {
    fn inspect(&mut self) -> Result<Vec<AnarlogInspection>, EvidenceError>;
}

/// Bounded adapter around a real Anarlog provider.
pub struct AnarlogAxSource<P> {
    meeting_id: String,
    provider: P,
}

impl<P> AnarlogAxSource<P> {
    pub fn new(meeting_id: impl Into<String>, provider: P) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            provider,
        }
    }
}

impl<P: AnarlogAxProvider> MeetingEvidenceSource for AnarlogAxSource<P> {
    fn source_id(&self) -> &str {
        "anarlog_meeting_ax"
    }

    fn poll(&mut self, max_observations: usize) -> Result<Vec<SpeakerEvidence>, EvidenceError> {
        let mut evidence = Vec::new();
        for inspection in self.provider.inspect()? {
            evidence.extend(normalize_anarlog_inspection(&self.meeting_id, inspection));
            if evidence.len() >= max_observations.min(64) {
                break;
            }
        }
        evidence.truncate(max_observations.min(64));
        Ok(evidence)
    }
}

/// Translate only direct Anarlog participant/active-speaker observations. A
/// participant roster with `is_active_speaker = None` remains evidence of
/// presence only and is not elevated to an active speaker signal.
pub fn normalize_anarlog_inspection(
    meeting_id: &str,
    inspection: AnarlogInspection,
) -> Vec<SpeakerEvidence> {
    let source = source_for_platform(&inspection.platform);
    inspection
        .active_speakers
        .into_iter()
        .take(64)
        .map(|participant| SpeakerEvidence {
            meeting_id: meeting_id.to_owned(),
            start_sample: inspection.observed_at_sample,
            end_sample: inspection.observed_at_sample,
            platform: inspection.platform.clone(),
            surface: inspection.surface.clone(),
            participant_id: participant.participant_id,
            display_name: participant.participant_name,
            is_self: participant.is_self,
            is_active: participant.is_active_speaker,
            is_muted: participant.is_muted,
            source,
            confidence: participant.confidence,
            observed_at_sample: inspection.observed_at_sample,
            signals: participant.signals,
        })
        .collect()
}

fn source_for_platform(platform: &str) -> EvidenceSource {
    match platform.to_ascii_lowercase().as_str() {
        "zoom" => EvidenceSource::ZoomAx,
        "meet" | "google_meet" => EvidenceSource::MeetAx,
        "teams" => EvidenceSource::TeamsAx,
        // This intentionally does not claim browser-extension evidence for an
        // arbitrary AX platform. It stays generic and must fail closed until a
        // supported platform/source trust rule exists.
        _ => EvidenceSource::GenericAx,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_anarlog_inspection, AnarlogInspection, AnarlogParticipantStream};
    use crate::evidence::EvidenceSource;

    #[test]
    fn roster_presence_does_not_turn_into_a_speaking_claim() {
        let evidence = normalize_anarlog_inspection(
            "m",
            AnarlogInspection {
                platform: "zoom".into(),
                surface: "native".into(),
                observed_at_sample: 1_600,
                active_speakers: vec![AnarlogParticipantStream {
                    participant_id: Some("p1".into()),
                    participant_name: Some("Akbar".into()),
                    is_self: Some(false),
                    is_active_speaker: None,
                    is_muted: Some(false),
                    confidence: 0.9,
                    signals: vec!["participant_roster".into()],
                }],
            },
        );
        assert_eq!(evidence[0].source, EvidenceSource::ZoomAx);
        assert_eq!(evidence[0].is_active, None);
        assert_eq!(evidence[0].display_name.as_deref(), Some("Akbar"));
    }
}
