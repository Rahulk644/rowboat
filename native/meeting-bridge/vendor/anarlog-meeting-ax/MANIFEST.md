# Anarlog `meeting_ax` provenance

This directory records the MIT-licensed source material adapted into
`src/evidence/anarlog_ax.rs`. It is deliberately a **source manifest**, not a
copy of the entire Anarlog application.

- Upstream: <https://github.com/fastrepl/anarlog>
- Exact revision: `609ee772801f29292e4edee453f269089ebf0e8b`
- License: [MIT](LICENSE)
- Local use: optional, native macOS Zoom Accessibility inspection only.
- Local patches: the implementation removes every non-Zoom platform, browser
  path, chat path, AX mutation path, screenshots, telemetry, source values for
  editable controls, and unrelated workspace dependencies. It retains strict
  traversal/time bounds and explicit-label parsing semantics.

## Audited source inputs

| Upstream file | SHA-256 at pinned revision | Local role |
| --- | --- | --- |
| `crates/detect/src/meeting_ax.rs` | `9ebc95a27cfc8d89b85932ead4c24bf970b90c53cc8521fbc5ff574824f3c2b2` | 18-depth/1,800-node traversal, 0.6-second AX timeout, single-window refusal |
| `crates/detect/src/meeting_ax/analysis.rs` | `1ebf6ecf1d6709ae1af63800a41902249157268f55892585c4ba63cb186dedfc` | explicit Zoom active-speaker parsing and generic-name rejection |
| `crates/detect/src/meeting_ax/node.rs` | `c09645e1433041bc374d0042faf0a67db7fb8bfdc114159767c926123e937806` | safe label treatment; never use editable control values |
| `crates/detect/src/meeting_ax/platform.rs` | `47932522b730b9d572c4fbe2e74f375f4d8209fe4032a09a3ba07812dfe8def7` | `us.zoom.xos` native bundle scope |
| `LICENSE` | `ba9cc3a7e074c5cfe3985d6956f24c9f7575592a0483e314c9fcb4f72ee1b615` | included verbatim above |

## Dependency and TCC notes

At this revision Anarlog's `detect` crate is workspace-coupled: it depends on
local `anlg-bundle`/`anlg-language` crates plus `cidre`, `objc2`, and several
application-wide dependencies. The local extraction intentionally avoids that
crate. `meeting-bridge` uses only the safe `cidre 0.15.0` AX/NS APIs and
`macos-accessibility-client 0.0.1`, locked in this component's `Cargo.lock`.

`application_is_trusted()` is a non-prompting check of macOS Accessibility
trust. The provider returns `PermissionDenied` when it is false; permission UX
belongs to Electron main. It emits no evidence until trust is granted.

## Qualification gate

Compile check proves the feature is linked, not that Zoom exposes these labels.
Before enabling this provider in a package, pass a physical macOS test with
Accessibility granted and a real native Zoom meeting: active remote name,
self marker, muted/idle transition, two active Zoom windows (must emit no
ambiguous evidence), and permission revoke/regrant. Record only aggregate
results; do not commit transcript text or participant names.
