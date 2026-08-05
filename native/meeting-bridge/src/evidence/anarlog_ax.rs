//! Compatibility boundary for Anarlog's MIT `meeting_ax` module.
//!
//! The macOS provider is a deliberately small adaptation of the pinned,
//! MIT-licensed source recorded in `vendor/anarlog-meeting-ax`. It has not
//! passed a physical TCC-enabled Zoom qualification yet, so callers must not
//! enable it for users solely because the feature compiles. This module keeps
//! the provider and translation boundary narrow enough that it cannot leak an
//! AX tree into Rowboat.

use super::{EvidenceError, EvidenceSource, MeetingEvidenceSource, SpeakerEvidence};

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
use std::{collections::HashSet, time::Instant};

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
use cidre::{arc, ax, cf, ns};

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const ZOOM_BUNDLE_ID: &str = "us.zoom.xos";
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const MAX_TREE_DEPTH: usize = 18;
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const MAX_NODES: usize = 1_800;
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const MAX_WINDOWS: usize = 8;
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const MAX_AUXILIARY_DIALOGS: usize = 4;
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const MAX_EXPOSED_SURFACES: usize = MAX_WINDOWS + MAX_AUXILIARY_DIALOGS + 8;
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const AX_DIAGNOSTICS_ENV: &str = "ROWBOAT_MEETING_BRIDGE_AX_DIAGNOSTICS";

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

/// Minimal provider needed by the adapter. A provider must use a bounded AX
/// traversal; it cannot substitute browser title text or a Calendar
/// participant list.
pub trait AnarlogAxProvider: Send {
    fn inspect(&mut self) -> Result<Vec<AnarlogInspection>, EvidenceError>;
}

/// Concrete, macOS-only native Zoom provider adapted from Anarlog's bounded
/// `meeting_ax` source at the revision recorded in `vendor/anarlog-meeting-ax`.
///
/// It has intentionally narrow scope: it inspects only Zoom's native process,
/// only after TCC Accessibility trust is granted, and emits only labels with an
/// explicit active-speaker state. It neither traverses browser tabs nor emits
/// raw Accessibility nodes, window titles, or arbitrary values.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug)]
pub struct MacosZoomAnarlogProvider {
    meeting_started_at: Instant,
    last_diagnostics: Option<AxDiagnostics>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl MacosZoomAnarlogProvider {
    /// `meeting_started_at` must use the same monotonic origin as the capture
    /// clock supplied to the bridge. This keeps observations alignable with
    /// transcript audio intervals without exposing wall-clock meeting data.
    #[must_use]
    pub fn new(meeting_started_at: Instant) -> Self {
        Self {
            meeting_started_at,
            last_diagnostics: None,
        }
    }

    fn observed_at_sample(&self) -> u64 {
        let micros = self.meeting_started_at.elapsed().as_micros();
        micros.saturating_mul(16).min(u128::from(u64::MAX)) as u64
    }

    /// Direct-helper diagnostics are deliberately opt-in and summary-only.
    /// They expose traversal counts/reasons, never AX labels, titles, values,
    /// names, process identifiers, or window bounds. Electron intentionally
    /// drains helper stderr, so this is for a terminal-driven physical
    /// qualification run only.
    fn emit_diagnostics_if_changed(&mut self, diagnostics: AxDiagnostics) {
        if !ax_diagnostics_enabled() || self.last_diagnostics.as_ref() == Some(&diagnostics) {
            return;
        }
        eprintln!(
            "meeting-bridge AX diagnostic: trusted={} zoom_processes={} outcomes={:?}",
            diagnostics.trusted, diagnostics.zoom_processes, diagnostics.outcomes
        );
        self.last_diagnostics = Some(diagnostics);
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl AnarlogAxProvider for MacosZoomAnarlogProvider {
    fn inspect(&mut self) -> Result<Vec<AnarlogInspection>, EvidenceError> {
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            self.emit_diagnostics_if_changed(AxDiagnostics::permission_denied());
            return Err(EvidenceError::PermissionDenied);
        }

        let observed_at_sample = self.observed_at_sample();
        let bundle_id = ns::String::with_str(ZOOM_BUNDLE_ID);
        let mut inspections = Vec::new();
        let mut zoom_processes = 0;
        let mut outcomes = Vec::new();
        for app in ns::RunningApp::with_bundle_id(&bundle_id).iter() {
            zoom_processes += 1;
            let ax_app = ax::UiElement::with_app_pid(app.pid());
            // Anarlog's per-process cap prevents an unresponsive AX target
            // from stalling capture/transport. Treat any inaccessible tree as
            // no evidence rather than guessing a speaker.
            let _ = ax_app.set_messaging_timeout_secs(0.6);
            let inspection = inspect_zoom_process(&ax_app);
            outcomes.push(inspection.diagnostic);
            if let Some(active_speakers) = inspection.active_speakers {
                inspections.push(AnarlogInspection {
                    platform: "zoom".to_string(),
                    surface: "native".to_string(),
                    observed_at_sample,
                    active_speakers,
                });
            }
        }
        self.emit_diagnostics_if_changed(AxDiagnostics::trusted(zoom_processes, outcomes));
        Ok(inspections)
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug)]
struct ZoomProcessInspection {
    active_speakers: Option<Vec<AnarlogParticipantStream>>,
    diagnostic: ZoomAxDiagnostic,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum ZoomAxDiagnostic {
    ApplicationWindowsUnavailable,
    ApplicationSurfaceLimitExceeded {
        primary_windows: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
    },
    SurfaceNodeTraversalRejected {
        primary_windows: usize,
        top_level_dialogs: usize,
    },
    MeetingWindowCount {
        primary_windows: usize,
        validated_meetings: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
    },
    ValidatedMeeting {
        primary_windows: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
        active_speaker_labels: usize,
    },
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct AxDiagnostics {
    trusted: bool,
    zoom_processes: usize,
    outcomes: Vec<ZoomAxDiagnostic>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
struct ZoomApplicationSurfaces {
    primary_windows: Vec<arc::R<ax::UiElement>>,
    top_level_dialogs: Vec<arc::R<ax::UiElement>>,
    ignored_surfaces: usize,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl AxDiagnostics {
    fn permission_denied() -> Self {
        Self {
            trusted: false,
            zoom_processes: 0,
            outcomes: Vec::new(),
        }
    }

    fn trusted(zoom_processes: usize, outcomes: Vec<ZoomAxDiagnostic>) -> Self {
        Self {
            trusted: true,
            zoom_processes,
            outcomes,
        }
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn ax_diagnostics_enabled() -> bool {
    std::env::var_os(AX_DIAGNOSTICS_ENV).is_some_and(|value| value == "1")
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn inspect_zoom_process(ax_app: &ax::UiElement) -> ZoomProcessInspection {
    let surfaces = match zoom_application_surfaces(ax_app) {
        Ok(surfaces) => surfaces,
        Err(diagnostic) => {
            return ZoomProcessInspection {
                active_speakers: None,
                diagnostic,
            };
        }
    };
    let primary_window_count = surfaces.primary_windows.len();
    let top_level_dialog_count = surfaces.top_level_dialogs.len();

    let mut window_nodes = Vec::new();
    for window in surfaces.primary_windows {
        let mut nodes = Vec::new();
        if !collect_nodes(&window, 0, &mut nodes) {
            return ZoomProcessInspection {
                active_speakers: None,
                diagnostic: ZoomAxDiagnostic::SurfaceNodeTraversalRejected {
                    primary_windows: primary_window_count,
                    top_level_dialogs: top_level_dialog_count,
                },
            };
        }
        window_nodes.push(nodes);
    }

    let mut auxiliary_dialog_nodes = Vec::new();
    for dialog in surfaces.top_level_dialogs {
        let mut nodes = Vec::new();
        if !collect_nodes(&dialog, 0, &mut nodes) {
            return ZoomProcessInspection {
                active_speakers: None,
                diagnostic: ZoomAxDiagnostic::SurfaceNodeTraversalRejected {
                    primary_windows: primary_window_count,
                    top_level_dialogs: top_level_dialog_count,
                },
            };
        }
        auxiliary_dialog_nodes.push(nodes);
    }
    inspect_zoom_windows(
        window_nodes,
        auxiliary_dialog_nodes,
        surfaces.ignored_surfaces,
    )
}

/// One validated meeting surface proves that this Zoom process is in a call.
/// With that proof, bounded Zoom windows and top-level macOS system dialogs
/// may contribute only an explicit `Talking: Name` assertion. Their other
/// labels never become speaker evidence.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn inspect_zoom_windows(
    window_nodes: Vec<Vec<ZoomAxNode>>,
    auxiliary_dialog_nodes: Vec<Vec<ZoomAxNode>>,
    ignored_surfaces: usize,
) -> ZoomProcessInspection {
    let candidates = window_nodes
        .iter()
        .enumerate()
        .filter_map(|(index, nodes)| zoom_meeting_window_is_validated(nodes).then_some(index))
        .collect::<Vec<_>>();
    // More than one plausible Zoom meeting window is ambiguous. The bridge
    // has no permission to choose based on title/layout heuristics.
    if candidates.len() != 1 {
        return ZoomProcessInspection {
            active_speakers: None,
            diagnostic: ZoomAxDiagnostic::MeetingWindowCount {
                primary_windows: window_nodes.len(),
                validated_meetings: candidates.len(),
                top_level_dialogs: auxiliary_dialog_nodes.len(),
                ignored_surfaces,
            },
        };
    }
    let meeting_window_index = candidates[0];
    let mut names = HashSet::new();
    let mut speakers = find_zoom_active_speakers(&window_nodes[meeting_window_index], &mut names);
    for (index, nodes) in window_nodes.iter().enumerate() {
        if index == meeting_window_index {
            continue;
        }
        speakers.extend(find_zoom_auxiliary_talking_speakers(nodes, &mut names));
    }
    for nodes in &auxiliary_dialog_nodes {
        speakers.extend(find_zoom_auxiliary_talking_speakers(nodes, &mut names));
    }
    ZoomProcessInspection {
        diagnostic: ZoomAxDiagnostic::ValidatedMeeting {
            primary_windows: window_nodes.len(),
            top_level_dialogs: auxiliary_dialog_nodes.len(),
            ignored_surfaces,
            active_speaker_labels: speakers.len(),
        },
        active_speakers: Some(speakers),
    }
}

/// Reads the AX API's dedicated top-level surface list instead of assuming the
/// application's generic child tree contains every window. Zoom's floating
/// speaking indicator is omitted by the latter but exposed by `AXWindows`.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_application_surfaces(
    ax_app: &ax::UiElement,
) -> Result<ZoomApplicationSurfaces, ZoomAxDiagnostic> {
    let Some(ax_windows) = application_windows(ax_app) else {
        return Err(ZoomAxDiagnostic::ApplicationWindowsUnavailable);
    };

    let mut surfaces = ZoomApplicationSurfaces {
        primary_windows: Vec::new(),
        top_level_dialogs: Vec::new(),
        ignored_surfaces: 0,
    };
    for surface in ax_windows.iter().take(MAX_EXPOSED_SURFACES + 1) {
        match surface.role().ok().map(|role| role.to_string()) {
            Some(role) if role == "AXWindow" => surfaces.primary_windows.push(surface.retained()),
            Some(role) if is_zoom_top_level_auxiliary_dialog(&role) => {
                surfaces.top_level_dialogs.push(surface.retained());
            }
            _ => surfaces.ignored_surfaces += 1,
        }
        if surfaces.primary_windows.len() > MAX_WINDOWS
            || surfaces.top_level_dialogs.len() > MAX_AUXILIARY_DIALOGS
            || surfaces.primary_windows.len()
                + surfaces.top_level_dialogs.len()
                + surfaces.ignored_surfaces
                > MAX_EXPOSED_SURFACES
        {
            return Err(ZoomAxDiagnostic::ApplicationSurfaceLimitExceeded {
                primary_windows: surfaces.primary_windows.len(),
                top_level_dialogs: surfaces.top_level_dialogs.len(),
                ignored_surfaces: surfaces.ignored_surfaces,
            });
        }
    }
    Ok(surfaces)
}

/// cidre exposes the raw `AXWindows` attribute safely but has no typed
/// shortcut for it. The Core Accessibility contract guarantees a CFArray of
/// AXUIElements. We check the outer CF type before this single, audited cast;
/// each item is used only through cidre's safe AX methods.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[allow(unsafe_code)]
fn application_windows(ax_app: &ax::UiElement) -> Option<arc::R<cf::ArrayOf<ax::UiElement>>> {
    let raw_windows = ax_app.attr_value(ax::attr::windows()).ok()?;
    (raw_windows.get_type_id() == cf::Array::type_id()).then(|| {
        // SAFETY: `AXWindows` is documented by the macOS Accessibility API as
        // a CFArray whose elements are AXUIElement values. The type-id check
        // rejects a malformed outer value before reinterpreting its retained
        // CF ownership wrapper.
        unsafe { std::mem::transmute(raw_windows) }
    })
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_top_level_auxiliary_dialog(role: &str) -> bool {
    matches!(role, "AXSystemDialog" | "AXDialog")
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_nodes(element: &ax::UiElement, depth: usize, nodes: &mut Vec<ZoomAxNode>) -> bool {
    if depth > MAX_TREE_DEPTH || nodes.len() >= MAX_NODES {
        return false;
    }
    nodes.push(snapshot_node(element));

    let Ok(children) = element.children() else {
        return !ax_role_may_have_children(
            nodes
                .last()
                .and_then(|node| node.role.as_deref())
                .unwrap_or_default(),
        );
    };
    children
        .iter()
        .all(|child| collect_nodes(child, depth + 1, nodes))
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn ax_role_may_have_children(role: &str) -> bool {
    matches!(
        role,
        "AXApplication"
            | "AXWindow"
            | "AXGroup"
            | "AXScrollArea"
            | "AXList"
            | "AXTable"
            | "AXOutline"
            | "AXRow"
            | "AXCell"
            | "AXSheet"
            | "AXSplitGroup"
            | "AXToolbar"
            | "AXTabGroup"
            | "AXMenuBar"
            | "AXMenu"
            | "AXPopover"
            | "AXBrowser"
            | "AXLayoutArea"
    )
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug)]
struct ZoomAxNode {
    element_hash: usize,
    role: Option<String>,
    title: Option<String>,
    description: Option<String>,
    placeholder: Option<String>,
    value: Option<String>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn snapshot_node(element: &ax::UiElement) -> ZoomAxNode {
    let role = element.role().ok().map(|role| role.to_string());
    let settable_value = element.is_settable(ax::attr::value()).unwrap_or(false);
    let is_input = matches!(
        role.as_deref(),
        Some("AXTextArea") | Some("AXTextField") | Some("AXSecureTextField")
    );
    ZoomAxNode {
        element_hash: element.hash(),
        role,
        title: string_attr(element, ax::attr::title()),
        description: string_attr(element, ax::attr::desc()),
        placeholder: string_attr(element, ax::attr::placeholder_value()),
        // Never read input values; speaker evidence lives in non-editable AX
        // labels. This is stricter than a generic accessibility snapshot.
        value: (!settable_value && !is_input)
            .then(|| string_attr(element, ax::attr::value()))
            .flatten(),
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn string_attr(element: &ax::UiElement, attr: &ax::Attr) -> Option<String> {
    element
        .attr_value(attr)
        .ok()?
        .try_as_string()
        .map(|value| value.to_string())
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn node_labels(node: &ZoomAxNode) -> impl Iterator<Item = &str> {
    [
        node.title.as_deref(),
        node.placeholder.as_deref(),
        node.description.as_deref(),
        node.value.as_deref(),
    ]
    .into_iter()
    .flatten()
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_meeting_window_is_validated(nodes: &[ZoomAxNode]) -> bool {
    nodes.iter().any(|node| {
        let role_matches = matches!(node.role.as_deref(), Some("AXGroup") | Some("AXCell"));
        let has_audio_state = node_labels(node).any(|label| {
            let label = label.to_ascii_lowercase();
            label.contains("computer audio") || label.contains("no audio connected")
        });
        role_matches && has_audio_state && node_labels(node).any(is_zoom_video_evidence_label)
    })
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_video_evidence_label(label: &str) -> bool {
    let lower = label.trim().to_ascii_lowercase();
    lower == "video tile"
        || lower
            .strip_prefix("video render ")
            .and_then(|rest| rest.split_once(','))
            .is_some_and(|(name, state)| {
                !name.trim().is_empty()
                    && (state.contains("computer audio") || state.contains("no audio connected"))
            })
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn find_zoom_active_speakers(
    nodes: &[ZoomAxNode],
    names: &mut HashSet<String>,
) -> Vec<AnarlogParticipantStream> {
    let mut streams = Vec::new();
    for node in nodes {
        if !matches!(
            node.role.as_deref(),
            Some("AXGroup") | Some("AXCell") | Some("AXRow")
        ) {
            continue;
        }
        let Some((label, name, is_self)) =
            node_labels(node).find_map(parse_zoom_active_speaker_label)
        else {
            continue;
        };
        if !names.insert(name.to_ascii_lowercase()) {
            continue;
        }
        let mut signals = vec!["speaker-state-label".to_string()];
        if label.to_ascii_lowercase().starts_with("video render ") {
            signals.push("video-label".to_string());
        }
        streams.push(AnarlogParticipantStream {
            participant_id: Some(format!("ax-element-{:x}", node.element_hash)),
            participant_name: Some(name),
            is_self: Some(is_self),
            is_active_speaker: Some(true),
            is_muted: None,
            confidence: 0.95,
            signals,
        });
    }
    streams
}

/// Auxiliary Zoom surfaces are intentionally stricter than the validated
/// meeting window: only an explicit `Talking: Name` state is accepted. This
/// lets the floating macOS speaking dialog work without allowing a roster or
/// generic window text to name a transcript interval.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn find_zoom_auxiliary_talking_speakers(
    nodes: &[ZoomAxNode],
    names: &mut HashSet<String>,
) -> Vec<AnarlogParticipantStream> {
    let mut streams = Vec::new();
    for node in nodes {
        if is_text_input_role(node.role.as_deref()) {
            continue;
        }
        let Some((_, name, is_self)) = node_labels(node).find_map(|label| {
            label
                .trim()
                .to_ascii_lowercase()
                .starts_with("talking:")
                .then(|| parse_zoom_active_speaker_label(label))
                .flatten()
        }) else {
            continue;
        };
        if !names.insert(name.to_ascii_lowercase()) {
            continue;
        }
        streams.push(AnarlogParticipantStream {
            participant_id: Some(format!("ax-element-{:x}", node.element_hash)),
            participant_name: Some(name),
            is_self: Some(is_self),
            is_active_speaker: Some(true),
            is_muted: None,
            confidence: 0.95,
            signals: vec![
                "speaker-state-label".to_string(),
                "auxiliary-talking-label".to_string(),
            ],
        });
    }
    streams
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_text_input_role(role: Option<&str>) -> bool {
    matches!(
        role,
        Some("AXTextArea") | Some("AXTextField") | Some("AXSecureTextField")
    )
}

/// Adapted from Anarlog's `participant_name_from_speaker_label` at the pinned
/// revision. It accepts only explicit speaker-state labels and rejects generic
/// subject words, so a participant roster cannot become a false speaker claim.
#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn parse_zoom_active_speaker_label(label: &str) -> Option<(&str, String, bool)> {
    let label = label.trim();
    let lower = label.to_ascii_lowercase();
    let is_self = lower.ends_with(" (you)");
    let without_self = if is_self {
        &label[..label.len() - " (you)".len()]
    } else {
        label
    };
    let lower = without_self.to_ascii_lowercase();
    let name = if lower.starts_with("active speaker: ") {
        &without_self["active speaker: ".len()..]
    } else if lower.starts_with("talking:") {
        &without_self["talking:".len()..]
    } else if lower.ends_with(" is speaking") {
        &without_self[..without_self.len() - " is speaking".len()]
    } else if let Some(index) = explicit_speaker_marker_index(&lower, ", active speaker") {
        &without_self[..index]
    } else if let Some(index) = explicit_speaker_marker_index(&lower, ", speaking") {
        &without_self[..index]
    } else {
        return None;
    };

    let name = name.trim();
    let name = name
        .strip_prefix("Video render ")
        .or_else(|| name.strip_prefix("video render "))
        .map_or(name, |rest| {
            rest.split(',').next().unwrap_or_default().trim()
        });
    plausible_participant_name(name).then(|| (label, name.to_string(), is_self))
}

#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn explicit_speaker_marker_index(label: &str, marker: &str) -> Option<usize> {
    let index = label.find(marker)?;
    let suffix = &label[index + marker.len()..];
    (suffix.is_empty() || suffix == " (you)").then_some(index)
}

#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn plausible_participant_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 80
        || name
            .chars()
            .any(|character| matches!(character, '\n' | '\r' | '?' | '!'))
    {
        return false;
    }
    const GENERIC_SUBJECTS: &[&str] = &[
        "anybody",
        "anyone",
        "everybody",
        "everyone",
        "nobody",
        "participant",
        "participants",
        "person",
        "somebody",
        "someone",
        "speaker",
        "speakers",
        "what",
        "who",
    ];
    let words = name
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_alphanumeric())
                .to_ascii_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    !words.is_empty()
        && words.len() <= 6
        && !words
            .iter()
            .any(|word| GENERIC_SUBJECTS.contains(&word.as_str()))
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
    use super::{
        normalize_anarlog_inspection, parse_zoom_active_speaker_label, AnarlogInspection,
        AnarlogParticipantStream,
    };
    use crate::evidence::EvidenceSource;

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    use super::{
        inspect_zoom_windows, is_zoom_top_level_auxiliary_dialog, ZoomAxDiagnostic, ZoomAxNode,
    };

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

    #[test]
    fn parses_only_explicit_zoom_speaker_labels() {
        let parsed = parse_zoom_active_speaker_label("Video render Akbar Khan, active speaker")
            .expect("explicit active speaker");
        assert_eq!(parsed.1, "Akbar Khan");
        assert!(!parsed.2);
        assert!(
            parse_zoom_active_speaker_label("Video render Akbar Khan, Computer audio unmuted")
                .is_none()
        );
        assert!(parse_zoom_active_speaker_label("Participants, active speaker").is_none());
        let talking = parse_zoom_active_speaker_label("Talking: Vikram Prasanna")
            .expect("explicit talking state");
        assert_eq!(talking.1, "Vikram Prasanna");
        assert!(parse_zoom_active_speaker_label("Talking:").is_none());
        assert!(parse_zoom_active_speaker_label("Talking:   ").is_none());
        assert!(parse_zoom_active_speaker_label("Talking: Speaker").is_none());
    }

    #[test]
    fn keeps_an_explicit_self_marker_for_the_resolver() {
        let parsed = parse_zoom_active_speaker_label("Grace Hopper is speaking (You)")
            .expect("explicit self speaker");
        assert_eq!(parsed.1, "Grace Hopper");
        assert!(parsed.2);
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    fn zoom_node(element_hash: usize, role: &str, title: &str) -> ZoomAxNode {
        ZoomAxNode {
            element_hash,
            role: Some(role.to_string()),
            title: Some(title.to_string()),
            description: None,
            placeholder: None,
            value: None,
        }
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn top_level_system_dialog_contributes_only_an_explicit_talking_label() {
        // The main meeting surface validates the Zoom meeting but has no
        // active-speaker state. Sky AX exposes that state in a top-level system
        // dialog instead of an AXWindow, represented here by static text.
        let meeting_window = vec![zoom_node(
            1,
            "AXGroup",
            "Video render Vikram Prasanna, Computer audio unmuted",
        )];
        let system_dialog = vec![zoom_node(2, "AXStaticText", "Talking: Vikram Prasanna")];
        let inspection = inspect_zoom_windows(vec![meeting_window], vec![system_dialog], 0);
        let speakers = inspection
            .active_speakers
            .as_ref()
            .expect("exactly one validated meeting window");

        assert_eq!(speakers.len(), 1);
        assert_eq!(
            speakers[0].participant_name.as_deref(),
            Some("Vikram Prasanna")
        );
        assert_eq!(speakers[0].is_active_speaker, Some(true));
        assert!(speakers[0]
            .signals
            .iter()
            .any(|signal| signal == "auxiliary-talking-label"));
        assert!(matches!(
            inspection.diagnostic,
            ZoomAxDiagnostic::ValidatedMeeting {
                primary_windows: 1,
                top_level_dialogs: 1,
                ignored_surfaces: 0,
                active_speaker_labels: 1,
            }
        ));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn top_level_dialog_cannot_name_a_transcript_without_one_validated_window() {
        let system_dialog = vec![zoom_node(2, "AXStaticText", "Talking: Vikram Prasanna")];
        let inspection = inspect_zoom_windows(Vec::new(), vec![system_dialog], 0);

        assert!(inspection.active_speakers.is_none());
        assert!(matches!(
            inspection.diagnostic,
            ZoomAxDiagnostic::MeetingWindowCount {
                primary_windows: 0,
                validated_meetings: 0,
                top_level_dialogs: 1,
                ignored_surfaces: 0,
            }
        ));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn only_explicit_top_level_system_dialog_roles_are_auxiliary_surfaces() {
        assert!(is_zoom_top_level_auxiliary_dialog("AXSystemDialog"));
        assert!(is_zoom_top_level_auxiliary_dialog("AXDialog"));
        assert!(!is_zoom_top_level_auxiliary_dialog("AXGroup"));
        assert!(!is_zoom_top_level_auxiliary_dialog("AXSheet"));
    }
}
