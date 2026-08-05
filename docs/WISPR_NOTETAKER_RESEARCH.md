# Wispr Flow Notetaker: clean-room research notes

**Scope:** installed Wispr Flow 1.6.399 behavior and publicly observable
application structure, reviewed on 2026-08-06. This is a product and
architecture comparison for Rowboat Meetings **Beta**. It is not a source-code
porting guide: no proprietary code, API endpoints, session material, assets,
screenshots, transcript content, or personal data were copied into this
repository.

## What the product demonstrates

Wispr treats a meeting as a durable local object, rather than a stream of text
that happens to be displayed in a note. The visible experience has a dedicated
Notetaker space for upcoming, active, and past meetings; a `New note` primary
action; a live transcript; and a settings page that makes capture behavior
legible before a call begins.

Observed settings and controls include:

- notification before scheduled meetings;
- optional detection of any call, followed by a prompt to start a note;
- a maximum-recording-length guardrail and stop-on-call-end behavior;
- an open-notepad-on-start preference, optional split-screen-on-join, live
  transcript visibility, and a meeting shortcut;
- capture protection for the Notepad and Flow Bar; and
- meeting-only sharing controls, with the transcript visible only to people
  explicitly invited to the note.

That makes the user journey clear: detect or start a meeting, make capture
state obvious, show the transcript while it is happening, then retain a
meeting artifact that can be refined and shared. It is a useful UX model for
Rowboat's existing in-app meeting view; it does **not** imply Rowboat needs a
second floating overlay or Nub.

## Clean-room architecture map

The following is an independent implementation map inferred from observed
behavior and product artifacts. Names in code are intentionally Rowboat names,
not copied identifiers.

```text
Capture coordinator
  ├── mic lane (starts independently at T0)
  ├── system/meeting lane
  │     ├── audio-only display capture on modern macOS where available
  │     └── user-approved screen-capture fallback where audio-only is absent
  ├── device-change and callback-health recovery
  └── call-detection adapters (per supported app)

Meeting store
  ├── meetings record and lifecycle versions
  ├── live transcript append log (live.ndjson)
  ├── revision/refinement append log (refined.ndjson)
  ├── participant and speaker observations
  └── upload, retry, stop, and refinement state

Attribution + presentation
  ├── speaker map built from bounded evidence
  ├── live transcript and note editor in Rowboat
  └── post-stop summary/refinement after capture has flushed
```

### Audio and recovery

The most important product technique is two independent lanes. Mic capture is
not gated on remote/system activity, so a remote participant who stays silent
does not erase the first ten minutes of local speech. Modern macOS can use an
audio-only `getDisplayMedia` path; a screen-capture path remains the
user-approved compatibility fallback. The capture owner should detect
`devicechange`, missing callbacks, and ended tracks, retry only the failed
source with bounded attempts, and mark a discontinuity epoch so text never
bridges a gap.

This aligns with Rowboat's current paired mic/system capture, health events,
and recovery work. Rowboat additionally has an explicit LocalVQE/WebRTC AEC3
comparison path and a fail-open raw-audio path; keep that quality gate rather
than replacing it with an undocumented product assumption.

### Durable meeting and transcript model

The observed product migrations indicate a local meeting table plus lifecycle
versions, transcript persistence, participant names, a speaker map, separate
live-audio/live-transcript upload state, and post-meeting summary/refinement
states with retries. An equivalent Rowboat model should retain two append-only
views:

- `live.ndjson` for idempotent, revisioned transcription records as they
  arrive; and
- `refined.ndjson` for later attribution/text/refinement revisions, never
  overwriting the raw live history.

This complements Rowboat's existing revision protocol. ASR, upload, and LLM
refinement must remain separate state machines: an upload or summary retry
cannot block capture, and a user editing a note must never be overwritten by a
late transcript revision.

### Speaker evidence and trust

The product shape supports persistent participant names and a speaker map, but
it does not justify treating a passive roster as proof. Rowboat should record
privacy-bounded observations such as participant fingerprint, self marker,
active/speaking state, mute state, time window, and source health. Each
attribution result should retain a provenance class:

| Result | Meaning |
| --- | --- |
| `matched` | direct, time-bounded evidence supports a particular participant |
| `ambiguous` | more than one plausible speaker; preserve the uncertainty |
| `unknown` | no qualifying evidence |
| `anchored` | strong contemporaneous observation supports the label |
| `broad` | weaker bounded context; not sufficient alone to name a turn |
| `cached` | prior meeting-local observation; never sufficient alone |

The `speakerMap` is a meeting-local evidence index, not an identity oracle.
For identical display names, Rowboat must use stable UI fingerprints internally
and show ambiguity unless the meeting app exposes an explicit self/active
marker. Calendar, contacts, attendee guesses, and email lookup remain
excluded.

### App detection, privacy, and platform boundary

Observed Notetaker behavior separates scheduled-meeting notification from
generic call detection. The clean-room counterpart is an app matrix: a small
adapter per supported meeting surface produces only start/ended/readiness
evidence, and capture still requires the normal macOS permissions. That keeps
application detection replaceable across Zoom, browser meetings, and later
Windows support.

Wispr's capture-protected Notepad/Flow Bar is also a good privacy pattern. For
Rowboat, protect only its own sensitive in-call UI; never use screen capture,
Accessibility trees, or unrelated window content as a general data source.
Native helpers remain thin platform adapters; the meeting state machine,
resolver contract, and UI stay cross-platform in Rowboat/Electron/Rust.

## Rowboat deltas

### Immediate must-have (Meeting Beta)

1. Keep independent mic and system capture at meeting start, with the
   audio-only/approved-fallback selection and source-specific recovery.
2. Qualify the durable local meeting lifecycle across apps: live/refined append
   logs, read-only database finalization, independently debounced platform end
   evidence, explicit stop/flush ordering, retry states, and no editor
   overwrite.
3. Persist bounded speaker observations and the meeting-local `speakerMap`;
   surface `You`, a directly evidenced name, `Unknown speaker`, or overlap
   honestly.
4. Ship the simple in-app Notetaker journey: manual start, a clear detected
   call prompt, live transcript, stopping state, and a completed meeting note.
5. Add capture protection for Rowboat's own active note/transcript surface,
   subject to platform support.

### Backlog / validate before adopting

- scheduled-meeting reminders and calendar sync;
- a full per-app detection matrix, browser extension/native-host integration,
  and Windows adapters;
- post-meeting sharing, collaborative meeting notes, imports (including
  Granola), and import/backfill state;
- AI meeting chat such as catch-up summaries, action items, pre-reads, title
  generation, and automations;
- reusable voice profiles or diarization beyond bounded meeting-local evidence;
- product-specific recording-length defaults and UI variants such as
  split-screen-on-join.

## Explicit exclusions

Calendar identity is not part of this plan: no Calendar permission, attendee
to speaker mapping, contact/email lookup, or Calendar-derived recording
decision. We also do not adopt proprietary network protocols, credentials,
transcription services, code, assets, or UI copy from Wispr. The durable value
of this research is the independently reproducible product pattern, not the
implementation of another application.

For Rowboat's current implementation and physical acceptance limits, see
[meetings-self-hosted-alpha.md](meetings-self-hosted-alpha.md).

## Implemented local connector

Rowboat now has an optional clean-room local connector that follows Wispr's
local live/refined meeting artifacts and read-only meeting database. Numeric
Wispr clusters are retained, explicit `speakerMap` assignments are applied in
their recorded provenance order, and the existing native Zoom Accessibility
adapter can provide timestamp-aligned names and a debounced end edge without
opening a second audio stream. The
installed 1.6.399 build contains an extension transcript callback, but the
entire extension system is controlled by Wispr's `ExtensionSystem` feature
flag; it was disabled for the qualified account. Rowboat therefore treats that
callback only as a possible latency accelerator and never as the correctness
path. In this provider mode Rowboat opens no audio streams and does not invoke
the self-hosted or Deepgram transcription paths. Setup, security boundaries,
rollback, and the physical acceptance script are in
[wispr-flow-local-connector.md](wispr-flow-local-connector.md).
