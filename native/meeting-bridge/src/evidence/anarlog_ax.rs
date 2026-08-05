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
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

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
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
const ZOOM_AX_ENHANCEMENT_RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

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
    enhancement_attempts: HashMap<i32, AxEnhancementAttempt>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone)]
struct AxEnhancementAttempt {
    attempted_at: Instant,
    succeeded: bool,
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
            enhancement_attempts: HashMap::new(),
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
            "meeting-bridge AX diagnostic: trusted={} zoom_processes={} enhancement_attempts={} enhanced_zoom_processes={} outcomes={:?}",
            diagnostics.trusted,
            diagnostics.zoom_processes,
            diagnostics.enhancement_attempts,
            diagnostics.enhanced_zoom_processes,
            diagnostics.outcomes
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
        let running_apps = ns::RunningApp::with_bundle_id(&bundle_id);
        let live_pids = running_apps
            .iter()
            .map(ns::RunningApp::pid)
            .collect::<HashSet<_>>();
        self.enhancement_attempts
            .retain(|pid, _| live_pids.contains(pid));
        let mut inspections = Vec::new();
        let mut zoom_processes = 0;
        let mut enhancement_attempts = 0;
        let mut enhanced_zoom_processes = 0;
        let mut outcomes = Vec::new();
        for app in running_apps.iter() {
            zoom_processes += 1;
            let pid = app.pid();
            let mut ax_app = ax::UiElement::with_app_pid(pid);
            let (attempted, enhanced) = ensure_zoom_enhanced_accessibility(
                &mut ax_app,
                pid,
                &mut self.enhancement_attempts,
                Instant::now(),
            );
            enhancement_attempts += usize::from(attempted);
            enhanced_zoom_processes += usize::from(enhanced);
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
        self.emit_diagnostics_if_changed(AxDiagnostics::trusted(
            zoom_processes,
            enhancement_attempts,
            enhanced_zoom_processes,
            outcomes,
        ));
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
    ApplicationSurfaceLimitExceeded {
        primary_windows: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
        discovery: SurfaceDiscoveryStats,
    },
    FallbackTraversalLimitExceeded {
        primary_windows: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
        discovery: SurfaceDiscoveryStats,
    },
    SurfaceNodeTraversalRejected {
        primary_windows: usize,
        top_level_dialogs: usize,
        discovery: SurfaceDiscoveryStats,
    },
    MeetingWindowCount {
        primary_windows: usize,
        validated_meetings: usize,
        top_level_dialogs: usize,
        auxiliary_talking_labels: usize,
        ignored_surfaces: usize,
        discovery: SurfaceDiscoveryStats,
        window_validation: Vec<ZoomWindowValidation>,
    },
    ValidatedMeeting {
        primary_windows: usize,
        top_level_dialogs: usize,
        ignored_surfaces: usize,
        active_speaker_labels: usize,
        discovery: SurfaceDiscoveryStats,
        window_validation: Vec<ZoomWindowValidation>,
    },
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct AxDiagnostics {
    trusted: bool,
    zoom_processes: usize,
    enhancement_attempts: usize,
    enhanced_zoom_processes: usize,
    outcomes: Vec<ZoomAxDiagnostic>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
struct ZoomApplicationSurfaces {
    primary_windows: Vec<arc::R<ax::UiElement>>,
    top_level_dialogs: Vec<arc::R<ax::UiElement>>,
    ignored_surfaces: usize,
    discovery: SurfaceDiscoveryStats,
    seen_surface_hashes: HashSet<usize>,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SurfaceDiscoveryStats {
    direct_ax_windows_available: bool,
    fallback_used: bool,
    fallback_visited_nodes: usize,
    fallback_skipped_branches: usize,
    focused_surface_candidates: usize,
}

/// Privacy-safe validator telemetry. These counts describe only the shape of
/// a bounded, already-accepted AX window snapshot; no AX strings, names, or
/// element identities are retained in diagnostics.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ZoomWindowValidation {
    snapshot_nodes: usize,
    non_input_nodes: usize,
    state_container_nodes: usize,
    static_text_nodes: usize,
    other_non_input_nodes: usize,
    video_evidence_nodes: usize,
    audio_state_nodes: usize,
    colocated_evidence_nodes: usize,
    leave_control_nodes: usize,
    participants_control_nodes: usize,
    mute_control_nodes: usize,
    explicit_talking_nodes: usize,
    video_active_nodes: usize,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl ZoomWindowValidation {
    fn is_valid(&self) -> bool {
        self.colocated_evidence_nodes > 0
            || (self.video_evidence_nodes > 0 && self.audio_state_nodes > 0)
            || (self.audio_state_nodes > 0
                && self.leave_control_nodes > 0
                && self.participants_control_nodes > 0
                && self.mute_control_nodes > 0)
            || (self.audio_state_nodes > 0 && self.explicit_talking_nodes > 0)
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
impl AxDiagnostics {
    fn permission_denied() -> Self {
        Self {
            trusted: false,
            zoom_processes: 0,
            enhancement_attempts: 0,
            enhanced_zoom_processes: 0,
            outcomes: Vec::new(),
        }
    }

    fn trusted(
        zoom_processes: usize,
        enhancement_attempts: usize,
        enhanced_zoom_processes: usize,
        outcomes: Vec<ZoomAxDiagnostic>,
    ) -> Self {
        Self {
            trusted: true,
            zoom_processes,
            enhancement_attempts,
            enhanced_zoom_processes,
            outcomes,
        }
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn ax_diagnostics_enabled() -> bool {
    std::env::var_os(AX_DIAGNOSTICS_ENV).is_some_and(|value| value == "1")
}

/// Zoom exposes its complete native meeting tree only after these two
/// application-level compatibility attributes are enabled. Fathom applies
/// the same pair immediately after creating its per-process AX application.
/// Keep the side effect Zoom-only, best-effort, and rate limited: failure must
/// never become speaker evidence or interrupt independent audio capture.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn ensure_zoom_enhanced_accessibility(
    ax_app: &mut ax::UiElement,
    pid: i32,
    attempts: &mut HashMap<i32, AxEnhancementAttempt>,
    now: Instant,
) -> (bool, bool) {
    if !zoom_ax_enhancement_retry_due(attempts.get(&pid), now) {
        return (
            false,
            attempts.get(&pid).is_some_and(|entry| entry.succeeded),
        );
    }

    let manual_attr_name = cf::String::from_str("AXManualAccessibility");
    let enhanced_attr_name = cf::String::from_str("AXEnhancedUserInterface");
    let manual_attr = ax::Attr::with_raw(&manual_attr_name);
    let enhanced_attr = ax::Attr::with_raw(&enhanced_attr_name);
    let enabled = ax_app
        .set_attr(&manual_attr, cf::Boolean::value_true().as_type_ref())
        .is_ok()
        & ax_app
            .set_attr(&enhanced_attr, cf::Boolean::value_true().as_type_ref())
            .is_ok();
    attempts.insert(
        pid,
        AxEnhancementAttempt {
            attempted_at: now,
            succeeded: enabled,
        },
    );
    (true, enabled)
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_ax_enhancement_retry_due(previous: Option<&AxEnhancementAttempt>, now: Instant) -> bool {
    previous.is_none_or(|previous| {
        now.checked_duration_since(previous.attempted_at)
            .is_none_or(|elapsed| elapsed >= ZOOM_AX_ENHANCEMENT_RETRY_INTERVAL)
    })
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
                    discovery: surfaces.discovery.clone(),
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
                    discovery: surfaces.discovery.clone(),
                },
            };
        }
        auxiliary_dialog_nodes.push(nodes);
    }
    inspect_zoom_windows(
        window_nodes,
        auxiliary_dialog_nodes,
        surfaces.ignored_surfaces,
        surfaces.discovery,
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
    discovery: SurfaceDiscoveryStats,
) -> ZoomProcessInspection {
    let auxiliary_talking_labels = auxiliary_dialog_nodes
        .iter()
        .flatten()
        .filter(|node| {
            !is_text_input_role(node.role.as_deref())
                && node_labels(node).any(is_zoom_explicit_talking_label)
        })
        .count();
    let window_validation = window_nodes
        .iter()
        .map(|nodes| zoom_meeting_window_validation(nodes))
        .collect::<Vec<_>>();
    let candidates = window_validation
        .iter()
        .enumerate()
        .filter_map(|(index, validation)| validation.is_valid().then_some(index))
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
                auxiliary_talking_labels,
                ignored_surfaces,
                discovery,
                window_validation,
            },
        };
    }
    let meeting_window_index = candidates[0];
    let account_self_name = zoom_account_self_name(&window_nodes);
    let mut names = HashSet::new();
    let mut speakers = find_zoom_active_speakers(
        &window_nodes[meeting_window_index],
        &mut names,
        account_self_name.as_deref(),
    );
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
            discovery,
            window_validation,
        },
        active_speakers: Some(speakers),
    }
}

/// Reads the AX API's dedicated top-level surface list instead of assuming the
/// application's generic child tree contains every window. Zoom's floating
/// speaking indicator can be omitted by that list, so a bounded, best-effort
/// child traversal supplements it only when a primary window or dialog is
/// missing.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_application_surfaces(
    ax_app: &ax::UiElement,
) -> Result<ZoomApplicationSurfaces, ZoomAxDiagnostic> {
    let mut surfaces = ZoomApplicationSurfaces {
        primary_windows: Vec::new(),
        top_level_dialogs: Vec::new(),
        ignored_surfaces: 0,
        discovery: SurfaceDiscoveryStats {
            direct_ax_windows_available: false,
            fallback_used: false,
            fallback_visited_nodes: 0,
            fallback_skipped_branches: 0,
            focused_surface_candidates: 0,
        },
        seen_surface_hashes: HashSet::new(),
    };
    if let Some(ax_windows) = application_windows(ax_app) {
        surfaces.discovery.direct_ax_windows_available = true;
        for surface in ax_windows.iter().take(MAX_EXPOSED_SURFACES + 1) {
            collect_surface(surface, &mut surfaces, true);
            if surface_limits_exceeded(&surfaces) {
                return Err(surface_limit_diagnostic(&surfaces));
            }
        }
    }

    if surfaces.primary_windows.is_empty() || surfaces.top_level_dialogs.is_empty() {
        surfaces.discovery.fallback_used = true;
        if !collect_fallback_surfaces(ax_app, &mut surfaces) {
            if surface_limits_exceeded(&surfaces) {
                return Err(surface_limit_diagnostic(&surfaces));
            }
            return Err(ZoomAxDiagnostic::FallbackTraversalLimitExceeded {
                primary_windows: surfaces.primary_windows.len(),
                top_level_dialogs: surfaces.top_level_dialogs.len(),
                ignored_surfaces: surfaces.ignored_surfaces,
                discovery: surfaces.discovery.clone(),
            });
        }
        collect_focused_surfaces(ax_app, &mut surfaces);
        if surface_limits_exceeded(&surfaces) {
            return Err(surface_limit_diagnostic(&surfaces));
        }
    }
    Ok(surfaces)
}

/// Traversal is explicitly best-effort: one inaccessible child represents an
/// unavailable AX branch, not evidence that its accessible siblings do not
/// exist. The traversal reads no labels or values; it recognizes only surface
/// roles, and fails closed if the bounded node budget is reached.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_fallback_surfaces(
    element: &ax::UiElement,
    surfaces: &mut ZoomApplicationSurfaces,
) -> bool {
    if surfaces.discovery.fallback_visited_nodes >= MAX_NODES {
        return false;
    }
    surfaces.discovery.fallback_visited_nodes += 1;

    let Ok(role) = element.role() else {
        surfaces.discovery.fallback_skipped_branches += 1;
        return true;
    };
    let role = role.to_string();
    let subrole = string_attr(element, ax::attr::subrole());
    collect_surface_with_role(element, &role, subrole.as_deref(), surfaces, false);
    if surface_limits_exceeded(surfaces) {
        return false;
    }

    let Ok(children) = element.children() else {
        if ax_role_may_have_children(&role) {
            surfaces.discovery.fallback_skipped_branches += 1;
        }
        return true;
    };
    for child in children.iter() {
        if !collect_fallback_surfaces(child, surfaces) {
            return false;
        }
    }
    true
}

/// Focus is used only as another surface handle. Its labels, values, and
/// descendants are never read here; downstream inspection still applies the
/// exact-one-primary-window and explicit-`Talking:` requirements.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_focused_surfaces(ax_app: &ax::UiElement, surfaces: &mut ZoomApplicationSurfaces) {
    let Ok(focused) = ax_app.focused_ui_element() else {
        return;
    };
    if collect_surface(&focused, surfaces, false) {
        surfaces.discovery.focused_surface_candidates += 1;
    }
    if let Ok(window) = focused.window() {
        if collect_surface(&window, surfaces, false) {
            surfaces.discovery.focused_surface_candidates += 1;
        }
    }
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_surface(
    surface: &ax::UiElement,
    surfaces: &mut ZoomApplicationSurfaces,
    count_ignored: bool,
) -> bool {
    let Some(role) = surface.role().ok().map(|role| role.to_string()) else {
        if count_ignored {
            surfaces.ignored_surfaces += 1;
        }
        return false;
    };
    let subrole = string_attr(surface, ax::attr::subrole());
    collect_surface_with_role(surface, &role, subrole.as_deref(), surfaces, count_ignored)
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_surface_with_role(
    surface: &ax::UiElement,
    role: &str,
    subrole: Option<&str>,
    surfaces: &mut ZoomApplicationSurfaces,
    count_ignored: bool,
) -> bool {
    if !surfaces.seen_surface_hashes.insert(surface.hash()) {
        return false;
    }
    if is_zoom_top_level_auxiliary_dialog(role, subrole) {
        surfaces.top_level_dialogs.push(surface.retained());
        return true;
    }
    if role == "AXWindow" {
        surfaces.primary_windows.push(surface.retained());
        return true;
    }
    if count_ignored {
        surfaces.ignored_surfaces += 1;
    }
    false
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn surface_limits_exceeded(surfaces: &ZoomApplicationSurfaces) -> bool {
    surfaces.primary_windows.len() > MAX_WINDOWS
        || surfaces.top_level_dialogs.len() > MAX_AUXILIARY_DIALOGS
        || surfaces.primary_windows.len()
            + surfaces.top_level_dialogs.len()
            + surfaces.ignored_surfaces
            > MAX_EXPOSED_SURFACES
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn surface_limit_diagnostic(surfaces: &ZoomApplicationSurfaces) -> ZoomAxDiagnostic {
    ZoomAxDiagnostic::ApplicationSurfaceLimitExceeded {
        primary_windows: surfaces.primary_windows.len(),
        top_level_dialogs: surfaces.top_level_dialogs.len(),
        ignored_surfaces: surfaces.ignored_surfaces,
        discovery: surfaces.discovery.clone(),
    }
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
fn is_zoom_top_level_auxiliary_dialog(role: &str, subrole: Option<&str>) -> bool {
    matches!(role, "AXSystemDialog" | "AXDialog")
        || (role == "AXWindow" && matches!(subrole, Some("AXSystemDialog") | Some("AXDialog")))
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn collect_nodes(element: &ax::UiElement, depth: usize, nodes: &mut Vec<ZoomAxNode>) -> bool {
    if depth > MAX_TREE_DEPTH || nodes.len() >= MAX_NODES {
        return false;
    }
    nodes.push(snapshot_node(element));

    let Ok(children) = element.children() else {
        // Zoom routinely exposes transient groups whose AXChildren request
        // cannot complete while the rest of the meeting tree is readable.
        // Fathom reconciles nodes seen through polling/notifications instead
        // of discarding that whole snapshot. Skip only this unavailable
        // branch; downstream meeting and speaker validators still fail closed
        // unless accessible siblings contain explicit evidence.
        return true;
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
    role_description: Option<String>,
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
        role_description: element.role_desc().ok().map(|value| value.to_string()),
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
fn zoom_meeting_window_validation(nodes: &[ZoomAxNode]) -> ZoomWindowValidation {
    let mut validation = ZoomWindowValidation {
        snapshot_nodes: nodes.len(),
        non_input_nodes: 0,
        state_container_nodes: 0,
        static_text_nodes: 0,
        other_non_input_nodes: 0,
        video_evidence_nodes: 0,
        audio_state_nodes: 0,
        colocated_evidence_nodes: 0,
        leave_control_nodes: 0,
        participants_control_nodes: 0,
        mute_control_nodes: 0,
        explicit_talking_nodes: 0,
        video_active_nodes: 0,
    };
    for node in nodes {
        if is_text_input_role(node.role.as_deref()) {
            continue;
        }
        validation.non_input_nodes += 1;
        match node.role.as_deref() {
            Some("AXGroup") | Some("AXCell") | Some("AXRow") => {
                validation.state_container_nodes += 1;
            }
            Some("AXStaticText") => validation.static_text_nodes += 1,
            _ => validation.other_non_input_nodes += 1,
        }
        let video_tile = parse_zoom_video_tile_node(node);
        let has_audio_state =
            video_tile.is_some() || node_labels(node).any(is_zoom_audio_state_label);
        let has_video_evidence =
            video_tile.is_some() || node_labels(node).any(is_zoom_video_evidence_label);
        let has_leave_control = node_labels(node).any(is_zoom_leave_control_label);
        let has_participants_control = node_labels(node).any(is_zoom_participants_control_label);
        let has_mute_control = node_labels(node).any(is_zoom_mute_control_label);
        let has_explicit_talking = node_labels(node).any(is_zoom_explicit_talking_label);
        let has_video_active = node_labels(node).any(is_zoom_video_active_label);
        validation.audio_state_nodes += usize::from(has_audio_state);
        validation.video_evidence_nodes += usize::from(has_video_evidence);
        validation.colocated_evidence_nodes += usize::from(has_audio_state && has_video_evidence);
        validation.leave_control_nodes += usize::from(has_leave_control);
        validation.participants_control_nodes += usize::from(has_participants_control);
        validation.mute_control_nodes += usize::from(has_mute_control);
        validation.explicit_talking_nodes += usize::from(has_explicit_talking);
        validation.video_active_nodes += usize::from(has_video_active);
    }
    validation
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_audio_state_label(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    lower.contains("computer audio") || lower.contains("no audio connected")
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZoomTileAudioState {
    Unmuted,
    Muted,
    Disconnected,
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ZoomVideoTile {
    element_hash: usize,
    participant_name: String,
    audio_state: ZoomTileAudioState,
}

/// Zoom 6.x exposes a video tile as an AXTabGroup whose localized role
/// description is `Video render`. The participant name and audio state are in
/// one separate AXDescription, not in a synthesized `Video render ...` label.
/// Accept this measured native shape without depending on screen geometry.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn parse_zoom_video_tile_node(node: &ZoomAxNode) -> Option<ZoomVideoTile> {
    if node.role.as_deref() != Some("AXTabGroup")
        || !node
            .role_description
            .as_deref()
            .is_some_and(|description| description.eq_ignore_ascii_case("Video render"))
    {
        return None;
    }
    let (name, state) = node.description.as_deref()?.split_once(',')?;
    let name = name.trim();
    if !plausible_participant_name(name) {
        return None;
    }
    let audio_state = state
        .split(',')
        .map(|part| part.trim().to_ascii_lowercase())
        .find_map(|part| match part.as_str() {
            "computer audio unmuted" => Some(ZoomTileAudioState::Unmuted),
            "computer audio muted" => Some(ZoomTileAudioState::Muted),
            "no audio connected" => Some(ZoomTileAudioState::Disconnected),
            _ => None,
        })?;
    Some(ZoomVideoTile {
        element_hash: node.element_hash,
        participant_name: name.to_string(),
        audio_state,
    })
}

/// Exact native Zoom meeting controls. These never inspect a window title or
/// arbitrary text, and audio-only validation requires all three independent
/// controls in addition to a real computer-audio state in the same AX window.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_leave_control_label(label: &str) -> bool {
    matches!(
        label.trim().to_ascii_lowercase().as_str(),
        "leave" | "leave meeting"
    )
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_participants_control_label(label: &str) -> bool {
    label.trim().eq_ignore_ascii_case("participants")
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_mute_control_label(label: &str) -> bool {
    matches!(
        label.trim().to_ascii_lowercase().as_str(),
        "mute" | "unmute"
    )
}

/// These predicates retain only a boolean/count for diagnostic and validation
/// purposes. The parsed participant name is never returned from this path.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_explicit_talking_label(label: &str) -> bool {
    label.trim().to_ascii_lowercase().starts_with("talking:")
        && parse_zoom_active_speaker_label(label).is_some()
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn is_zoom_video_active_label(label: &str) -> bool {
    label
        .trim()
        .to_ascii_lowercase()
        .starts_with("video render ")
        && parse_zoom_active_speaker_label(label).is_some()
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
    account_self_name: Option<&str>,
) -> Vec<AnarlogParticipantStream> {
    let mut streams = Vec::new();
    // A participant row can establish only the local user's name, and only
    // within this already-validated Zoom meeting window. It is never emitted
    // as speaker evidence by itself; it can merely mark an independently
    // explicit active-speaker label for that exact same name as self.
    let participants_self_name = zoom_participants_self_name(nodes);
    let tile_name_counts = zoom_video_tile_name_counts(nodes);
    for node in nodes {
        if is_text_input_role(node.role.as_deref()) {
            continue;
        }
        let state_container = matches!(
            node.role.as_deref(),
            Some("AXGroup") | Some("AXCell") | Some("AXRow")
        );
        let Some((label, name, label_marks_self)) = node_labels(node).find_map(|label| {
            let lower = label.trim().to_ascii_lowercase();
            (state_container || lower.starts_with("talking:") || lower.starts_with("video render "))
                .then(|| parse_zoom_active_speaker_label(label))
                .flatten()
        }) else {
            continue;
        };
        if !names.insert(name.to_ascii_lowercase()) {
            continue;
        }
        let is_participants_self_match = participants_self_name
            .as_deref()
            .is_some_and(|self_name| name.eq_ignore_ascii_case(self_name));
        let is_account_self_match = account_self_name.is_some_and(|self_name| {
            name.eq_ignore_ascii_case(self_name)
                && tile_name_counts
                    .get(&name.to_ascii_lowercase())
                    .is_some_and(|count| *count == 1)
        });
        let is_self = label_marks_self || is_participants_self_match || is_account_self_match;
        let mut signals = vec!["speaker-state-label".to_string()];
        if label.to_ascii_lowercase().starts_with("video render ") {
            signals.push("video-label".to_string());
        }
        if is_participants_self_match && !label_marks_self {
            signals.push("participants-self-match".to_string());
        }
        if is_account_self_match && !label_marks_self && !is_participants_self_match {
            signals.push("account-self-match".to_string());
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
    if streams.is_empty() {
        streams.extend(find_zoom_sole_unmuted_speaker(
            nodes,
            names,
            participants_self_name.as_deref(),
            account_self_name,
        ));
    }
    streams
}

#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_video_tile_name_counts(nodes: &[ZoomAxNode]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for tile in nodes.iter().filter_map(parse_zoom_video_tile_node) {
        *counts
            .entry(tile.participant_name.to_ascii_lowercase())
            .or_insert(0) += 1;
    }
    counts
}

/// Zoom's signed-in account button is passive self-identity evidence. It can
/// classify a separately proven speaker or an acoustically qualified mic, but
/// it never emits a speaking interval on its own.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_account_self_name(windows: &[Vec<ZoomAxNode>]) -> Option<String> {
    let candidates = windows
        .iter()
        .flatten()
        .filter(|node| node.role.as_deref() == Some("AXButton"))
        .filter_map(|node| node.description.as_deref())
        .filter_map(|description| {
            let mut parts = description.split(',').map(str::trim);
            let product = parts.next()?;
            let name = parts.next()?;
            let meeting_state = parts.next()?;
            (product.eq_ignore_ascii_case("Zoom")
                && meeting_state.eq_ignore_ascii_case("In a Zoom Meeting")
                && plausible_participant_name(name))
            .then(|| name.to_string())
        })
        .collect::<Vec<_>>();
    let unique = candidates
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    (unique.len() == 1)
        .then(|| candidates.into_iter().next())
        .flatten()
}

/// Current compact Zoom 6.x windows expose audio state but no textual active
/// speaker marker. When exactly one participant tile is unmuted, any aligned
/// system-ASR speech has one possible participant source. Multiple unmuted
/// tiles remain ambiguous and produce no evidence.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn find_zoom_sole_unmuted_speaker(
    nodes: &[ZoomAxNode],
    names: &mut HashSet<String>,
    participants_self_name: Option<&str>,
    account_self_name: Option<&str>,
) -> Vec<AnarlogParticipantStream> {
    let tiles = nodes
        .iter()
        .filter_map(parse_zoom_video_tile_node)
        .collect::<Vec<_>>();
    let unmuted = tiles
        .iter()
        .filter(|tile| tile.audio_state == ZoomTileAudioState::Unmuted)
        .collect::<Vec<_>>();
    let [tile] = unmuted.as_slice() else {
        return Vec::new();
    };
    if !names.insert(tile.participant_name.to_ascii_lowercase()) {
        return Vec::new();
    }
    let same_name_tiles = tiles
        .iter()
        .filter(|candidate| {
            candidate
                .participant_name
                .eq_ignore_ascii_case(&tile.participant_name)
        })
        .count();
    let known_self_name = participants_self_name.or(account_self_name);
    let is_self = known_self_name.map(|self_name| {
        same_name_tiles == 1 && tile.participant_name.eq_ignore_ascii_case(self_name)
    });
    vec![AnarlogParticipantStream {
        participant_id: Some(format!("ax-element-{:x}", tile.element_hash)),
        participant_name: Some(tile.participant_name.clone()),
        is_self,
        is_active_speaker: Some(true),
        is_muted: Some(false),
        confidence: 0.78,
        signals: vec![
            "video-tile-audio-state".to_string(),
            "sole-unmuted-tile".to_string(),
        ],
    }]
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

/// Return one self name only from an exact participant-row marker in a Zoom
/// meeting window that also exposes the native Participants control. This is
/// intentionally not a generic roster parser: ambiguous/missing rows are
/// ignored, and the result is used only to classify an explicit speaker label.
#[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
fn zoom_participants_self_name(nodes: &[ZoomAxNode]) -> Option<String> {
    let has_participants_control = nodes.iter().any(|node| {
        !is_text_input_role(node.role.as_deref())
            && node_labels(node).any(is_zoom_participants_control_label)
    });
    if !has_participants_control {
        return None;
    }

    let self_names = nodes
        .iter()
        .filter(|node| node.role.as_deref() == Some("AXRow"))
        .filter(|node| !is_text_input_role(node.role.as_deref()))
        .flat_map(node_labels)
        .filter_map(parse_zoom_participant_self_row_label)
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    (self_names.len() == 1)
        .then(|| self_names.into_iter().next())
        .flatten()
}

/// Adapted from Anarlog's `participant_name_from_speaker_label` at the pinned
/// revision. It accepts only explicit speaker-state labels and rejects generic
/// subject words, so a participant roster cannot become a false speaker claim.
#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn parse_zoom_active_speaker_label(label: &str) -> Option<(&str, String, bool)> {
    let label = label.trim();
    let (without_self, is_self) = strip_zoom_self_suffix(label);
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

/// Zoom's current English self markers vary by account role. They are parsed
/// only after an explicit active-speaker grammar has matched; a suffix alone
/// is never speaker evidence.
#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn strip_zoom_self_suffix(label: &str) -> (&str, bool) {
    const SELF_SUFFIXES: &[&str] = &[" (you)", " (me)", " (host, me)", " (co-host, me)"];
    let lower = label.to_ascii_lowercase();
    for suffix in SELF_SUFFIXES {
        if lower.ends_with(suffix) {
            return (&label[..label.len() - suffix.len()], true);
        }
    }
    (label, false)
}

/// Participant rows are passive identity evidence. Accept only a bare,
/// plausible name with a current Zoom self suffix; active-state labels, video
/// labels, punctuation-delimited UI phrases, and generic roster text remain
/// out of this path.
#[cfg(any(test, all(target_os = "macos", feature = "anarlog-ax")))]
fn parse_zoom_participant_self_row_label(label: &str) -> Option<String> {
    let label = label.trim();
    if parse_zoom_active_speaker_label(label).is_some() {
        return None;
    }
    let (name, is_self) = strip_zoom_self_suffix(label);
    let name = name.trim();
    (is_self
        && !name.to_ascii_lowercase().starts_with("video render ")
        && !name.contains(':')
        && !name.contains(','))
    .then(|| plausible_participant_name(name).then(|| name.to_string()))
    .flatten()
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
        normalize_anarlog_inspection, parse_zoom_active_speaker_label,
        parse_zoom_participant_self_row_label, AnarlogInspection, AnarlogParticipantStream,
    };
    use crate::evidence::EvidenceSource;

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    use super::{
        find_zoom_active_speakers, inspect_zoom_windows, is_zoom_top_level_auxiliary_dialog,
        zoom_account_self_name, zoom_ax_enhancement_retry_due, zoom_meeting_window_validation,
        AxEnhancementAttempt, SurfaceDiscoveryStats, ZoomAxDiagnostic, ZoomAxNode,
    };
    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    use std::{
        collections::HashSet,
        time::{Duration, Instant},
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

    #[test]
    fn accepts_current_zoom_self_suffixes_only_on_explicit_speaker_labels() {
        for label in [
            "Talking: Rahul Khatri (me)",
            "Rahul Khatri, active speaker (Host, me)",
            "Video render Rahul Khatri, active speaker (Co-host, me)",
        ] {
            let parsed = parse_zoom_active_speaker_label(label).expect("explicit self speaker");
            assert_eq!(parsed.1, "Rahul Khatri");
            assert!(parsed.2, "{label}");
        }

        // Muted/video labels establish a meeting surface but are not an
        // active-speaker assertion, even when they contain a local name.
        assert!(
            parse_zoom_active_speaker_label("Video render Rahul Khatri, Computer audio muted")
                .is_none()
        );
        assert!(parse_zoom_active_speaker_label("Rahul Khatri (Host, me)").is_none());
    }

    #[test]
    fn accepts_a_bare_self_marked_participant_row_but_not_a_speaking_label() {
        assert_eq!(
            parse_zoom_participant_self_row_label("Rahul Khatri (Host, me)").as_deref(),
            Some("Rahul Khatri")
        );
        assert!(parse_zoom_participant_self_row_label("Talking: Rahul Khatri (me)").is_none());
        assert!(parse_zoom_participant_self_row_label("Rahul Khatri (Host, me), muted").is_none());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    fn zoom_node(element_hash: usize, role: &str, title: &str) -> ZoomAxNode {
        ZoomAxNode {
            element_hash,
            role: Some(role.to_string()),
            role_description: None,
            title: Some(title.to_string()),
            description: None,
            placeholder: None,
            value: None,
        }
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    fn zoom_video_node(element_hash: usize, name: &str, audio_state: &str) -> ZoomAxNode {
        ZoomAxNode {
            element_hash,
            role: Some("AXTabGroup".to_string()),
            role_description: Some("Video render".to_string()),
            title: None,
            description: Some(format!("{name}, {audio_state}")),
            placeholder: None,
            value: None,
        }
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    fn zoom_account_node(element_hash: usize, description: &str) -> ZoomAxNode {
        ZoomAxNode {
            element_hash,
            role: Some("AXButton".to_string()),
            role_description: Some("button".to_string()),
            title: None,
            description: Some(description.to_string()),
            placeholder: None,
            value: None,
        }
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    fn surface_discovery() -> SurfaceDiscoveryStats {
        SurfaceDiscoveryStats {
            direct_ax_windows_available: true,
            fallback_used: false,
            fallback_visited_nodes: 0,
            fallback_skipped_branches: 0,
            focused_surface_candidates: 0,
        }
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn split_audio_and_video_evidence_validates_only_inside_one_window() {
        let validation = zoom_meeting_window_validation(&[
            zoom_node(1, "AXGroup", "Video tile"),
            zoom_node(2, "AXCell", "Computer audio unmuted"),
        ]);
        assert_eq!(validation.snapshot_nodes, 2);
        assert_eq!(validation.non_input_nodes, 2);
        assert_eq!(validation.state_container_nodes, 2);
        assert_eq!(validation.video_evidence_nodes, 1);
        assert_eq!(validation.audio_state_nodes, 1);
        assert_eq!(validation.colocated_evidence_nodes, 0);
        assert!(validation.is_valid());

        let video_only = zoom_meeting_window_validation(&[zoom_node(3, "AXGroup", "Video tile")]);
        assert!(!video_only.is_valid());
        let audio_only =
            zoom_meeting_window_validation(&[zoom_node(4, "AXCell", "Computer audio unmuted")]);
        assert!(!audio_only.is_valid());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn current_zoom_video_render_role_validates_and_names_a_sole_unmuted_tile() {
        let nodes = [
            zoom_video_node(1, "Akbar Khan", "Computer audio unmuted"),
            zoom_video_node(2, "Parminder Singh", "Computer audio muted, Video off"),
        ];
        let validation = zoom_meeting_window_validation(&nodes);
        assert_eq!(validation.video_evidence_nodes, 2);
        assert_eq!(validation.audio_state_nodes, 2);
        assert_eq!(validation.colocated_evidence_nodes, 2);
        assert!(validation.is_valid());

        let mut names = HashSet::new();
        let speakers = find_zoom_active_speakers(&nodes, &mut names, Some("Parminder Singh"));
        assert_eq!(speakers.len(), 1);
        assert_eq!(speakers[0].participant_name.as_deref(), Some("Akbar Khan"));
        assert_eq!(speakers[0].is_self, Some(false));
        assert_eq!(speakers[0].is_muted, Some(false));
        assert!(speakers[0]
            .signals
            .iter()
            .any(|signal| signal == "sole-unmuted-tile"));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn multiple_unmuted_tiles_and_duplicate_self_names_remain_ambiguous() {
        let both_unmuted = [
            zoom_video_node(1, "Akbar Khan", "Computer audio unmuted"),
            zoom_video_node(2, "Parminder Singh", "Computer audio unmuted"),
        ];
        let mut ambiguous_names = HashSet::new();
        assert!(find_zoom_active_speakers(
            &both_unmuted,
            &mut ambiguous_names,
            Some("Parminder Singh"),
        )
        .is_empty());

        let duplicate_names = [
            zoom_video_node(3, "Rahul Khatri", "Computer audio unmuted"),
            zoom_video_node(4, "Rahul Khatri", "Computer audio muted"),
        ];
        let mut duplicate_name_set = HashSet::new();
        let speakers = find_zoom_active_speakers(
            &duplicate_names,
            &mut duplicate_name_set,
            Some("Rahul Khatri"),
        );
        assert_eq!(speakers.len(), 1);
        assert_eq!(
            speakers[0].participant_name.as_deref(),
            Some("Rahul Khatri")
        );
        assert_eq!(speakers[0].is_self, Some(false));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn signed_in_zoom_account_is_passive_self_identity_only() {
        let windows = vec![vec![
            zoom_account_node(1, "Zoom, Rahul Khatri, In a Zoom Meeting, Basic account"),
            zoom_account_node(2, "Open activity center, New messages"),
        ]];
        assert_eq!(
            zoom_account_self_name(&windows).as_deref(),
            Some("Rahul Khatri")
        );

        let not_in_meeting = vec![vec![zoom_account_node(
            3,
            "Zoom, Rahul Khatri, Available, Basic account",
        )]];
        assert!(zoom_account_self_name(&not_in_meeting).is_none());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn current_zoom_static_text_evidence_is_accepted_but_input_text_is_not() {
        let static_text = zoom_meeting_window_validation(&[
            zoom_node(1, "AXStaticText", "Video tile"),
            zoom_node(2, "AXStaticText", "Computer audio unmuted"),
        ]);
        assert_eq!(static_text.static_text_nodes, 2);
        assert!(static_text.is_valid());

        let input_text = zoom_meeting_window_validation(&[
            zoom_node(3, "AXTextField", "Video tile"),
            zoom_node(4, "AXTextArea", "Computer audio unmuted"),
        ]);
        assert_eq!(input_text.non_input_nodes, 0);
        assert!(!input_text.is_valid());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn audio_only_mini_window_requires_three_exact_meeting_controls() {
        let meeting_controls = zoom_meeting_window_validation(&[
            zoom_node(1, "AXStaticText", "Computer audio unmuted"),
            zoom_node(2, "AXButton", "Leave"),
            zoom_node(3, "AXButton", "Participants"),
            zoom_node(4, "AXButton", "Mute"),
        ]);
        assert_eq!(meeting_controls.video_evidence_nodes, 0);
        assert_eq!(meeting_controls.audio_state_nodes, 1);
        assert_eq!(meeting_controls.leave_control_nodes, 1);
        assert_eq!(meeting_controls.participants_control_nodes, 1);
        assert_eq!(meeting_controls.mute_control_nodes, 1);
        assert!(meeting_controls.is_valid());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn audio_settings_or_home_controls_cannot_validate_an_audio_only_window() {
        let audio_settings = zoom_meeting_window_validation(&[
            zoom_node(1, "AXStaticText", "Computer audio unmuted"),
            zoom_node(2, "AXButton", "Mute"),
            zoom_node(3, "AXStaticText", "Audio settings"),
        ]);
        assert!(!audio_settings.is_valid());

        let home_surface = zoom_meeting_window_validation(&[
            zoom_node(4, "AXButton", "Leave"),
            zoom_node(5, "AXButton", "Participants"),
            zoom_node(6, "AXButton", "Unmute"),
            zoom_node(7, "AXStaticText", "Home"),
        ]);
        assert!(!home_surface.is_valid());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn audio_and_explicit_talking_prove_a_compact_meeting_surface_without_controls() {
        let compact_meeting = zoom_meeting_window_validation(&[
            zoom_node(1, "AXStaticText", "Computer audio unmuted"),
            zoom_node(2, "AXStaticText", "Talking: Rakshit Singh"),
        ]);
        assert_eq!(compact_meeting.explicit_talking_nodes, 1);
        assert_eq!(compact_meeting.video_active_nodes, 0);
        assert!(compact_meeting.is_valid());

        let talking_without_audio = zoom_meeting_window_validation(&[zoom_node(
            3,
            "AXStaticText",
            "Talking: Rakshit Singh",
        )]);
        assert!(!talking_without_audio.is_valid());
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn non_input_static_text_accepts_only_explicit_talking_or_video_active_labels() {
        let mut names = HashSet::new();
        let streams = find_zoom_active_speakers(
            &[
                zoom_node(1, "AXStaticText", "Talking: Rakshit Singh"),
                zoom_node(2, "AXStaticText", "Rakshit Singh is speaking"),
                zoom_node(3, "AXTextField", "Talking: Input Text"),
            ],
            &mut names,
            None,
        );

        assert_eq!(streams.len(), 1);
        assert_eq!(
            streams[0].participant_name.as_deref(),
            Some("Rakshit Singh")
        );
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn participant_self_row_only_classifies_a_matching_explicit_speaker() {
        let mut names = HashSet::new();
        let streams = find_zoom_active_speakers(
            &[
                zoom_node(1, "AXButton", "Participants"),
                zoom_node(2, "AXRow", "Rahul Khatri (Host, me)"),
                zoom_node(3, "AXStaticText", "Talking: Rahul Khatri"),
                zoom_node(4, "AXStaticText", "Talking: Vikram Prasanna"),
            ],
            &mut names,
            None,
        );

        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].participant_name.as_deref(), Some("Rahul Khatri"));
        assert_eq!(streams[0].is_self, Some(true));
        assert!(streams[0]
            .signals
            .iter()
            .any(|signal| signal == "participants-self-match"));
        assert_eq!(
            streams[1].participant_name.as_deref(),
            Some("Vikram Prasanna")
        );
        assert_eq!(streams[1].is_self, Some(false));

        let mut roster_only_names = HashSet::new();
        let roster_only = find_zoom_active_speakers(
            &[
                zoom_node(5, "AXButton", "Participants"),
                zoom_node(6, "AXRow", "Rahul Khatri (Host, me)"),
            ],
            &mut roster_only_names,
            None,
        );
        assert!(roster_only.is_empty());
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
        let inspection = inspect_zoom_windows(
            vec![meeting_window],
            vec![system_dialog],
            0,
            surface_discovery(),
        );
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
                ..
            }
        ));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn top_level_dialog_cannot_name_a_transcript_without_one_validated_window() {
        let system_dialog = vec![zoom_node(2, "AXStaticText", "Talking: Vikram Prasanna")];
        let inspection =
            inspect_zoom_windows(Vec::new(), vec![system_dialog], 0, surface_discovery());

        assert!(inspection.active_speakers.is_none());
        assert!(matches!(
            inspection.diagnostic,
            ZoomAxDiagnostic::MeetingWindowCount {
                primary_windows: 0,
                validated_meetings: 0,
                top_level_dialogs: 1,
                ignored_surfaces: 0,
                ..
            }
        ));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn only_explicit_top_level_system_dialog_roles_are_auxiliary_surfaces() {
        assert!(is_zoom_top_level_auxiliary_dialog("AXSystemDialog", None));
        assert!(is_zoom_top_level_auxiliary_dialog("AXDialog", None));
        assert!(is_zoom_top_level_auxiliary_dialog(
            "AXWindow",
            Some("AXSystemDialog")
        ));
        assert!(is_zoom_top_level_auxiliary_dialog(
            "AXWindow",
            Some("AXDialog")
        ));
        assert!(!is_zoom_top_level_auxiliary_dialog("AXWindow", None));
        assert!(!is_zoom_top_level_auxiliary_dialog(
            "AXWindow",
            Some("AXStandardWindow")
        ));
        assert!(!is_zoom_top_level_auxiliary_dialog("AXGroup", None));
        assert!(!is_zoom_top_level_auxiliary_dialog("AXSheet", None));
    }

    #[cfg(all(target_os = "macos", feature = "anarlog-ax"))]
    #[test]
    fn zoom_enhancement_attempts_are_cached_for_five_minutes_per_pid() {
        let attempted_at = Instant::now();
        let previous = AxEnhancementAttempt {
            attempted_at,
            succeeded: true,
        };

        assert!(!zoom_ax_enhancement_retry_due(
            Some(&previous),
            attempted_at + Duration::from_secs(299)
        ));
        assert!(zoom_ax_enhancement_retry_due(
            Some(&previous),
            attempted_at + Duration::from_secs(300)
        ));
        assert!(zoom_ax_enhancement_retry_due(None, attempted_at));
    }
}
