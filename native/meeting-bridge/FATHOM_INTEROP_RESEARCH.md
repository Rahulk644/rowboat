# Fathom native-Zoom interoperability research

This document records behavior-level interoperability research against the
locally installed Fathom 3.5.0 desktop application. It is a clean-room design
record: this repository contains no Fathom source, binary, configuration,
credentials, endpoints, Accessibility dumps, participant data, or transcript
content.

## What supplies speaker names

Fathom separates three responsibilities:

1. `FathomAudioMonitor` observes CoreAudio process/device activity. It can
   establish that Zoom is using audio, but it does not attribute speech.
2. `FathomMeetingMonitor` owns native meeting discovery, participant state,
   mute state, and active-speaker Accessibility evidence.
3. Its Chrome native host is a separate browser-extension bridge. It is not
   involved in native Zoom attribution.

Therefore Rowboat must never convert "Zoom has audio" into a participant name.
Only an explicit active-speaker Accessibility assertion may name an interval.

## Zoom application enhancement

Static analysis of the arm64 `FathomMeetingMonitor` executable shows that,
immediately after `AXUIElementCreateApplication`, Fathom best-effort sets these
application-level attributes to Core Foundation `true`:

```text
AXManualAccessibility
AXEnhancedUserInterface
```

The setter is visible in the installed 3.5.0 image around VM address
`0x10015f524`; the two attribute literals and setter calls are around
`0x10015f544`/`0x10015f57c` and `0x10015f58c`/`0x10015f5b0`. Reflection and
disassembly also expose a per-PID cache containing the AX application, bundle
ID, enhanced flag, and an expiry calculated at approximately 300 seconds.

Rowboat mirrors the technique, not the implementation: the Rust provider
applies both attributes only to an already-validated `us.zoom.xos` process,
rate-limits attempts per PID for five minutes, discards state when that PID
exits, and treats failure as no additional evidence. Audio capture remains
independent.

## Snapshot and observer design

The native image exposes `AXObserverManager`, `TreeSnapshot`,
`DetectionQuery`, `ParticipantMonitor`, and `PlatformMonitor` types. Observable
state includes process-keyed observers, coalescing, current participants, last
speakers, polling interval/timeout, and nodes last seen by polling versus AX
notification. Native events include participant, active-speaker, mute,
meeting-window, and visibility changes.

The resulting design is event-assisted reconciliation:

- AX notifications invalidate/coalesce state quickly;
- bounded polling reconciles dropped or transient notifications;
- participant fingerprints and last-speaker state survive short Zoom window
  transitions;
- meeting end is debounced instead of inferred from one missing surface.

The current Rowboat alpha implements the richer application exposure,
bounded polling, strict evidence parser, and temporary resolver evidence. A
process-keyed AX observer plus participant reconciliation cache remains a
follow-up; it must retain only normalized meeting evidence, never a raw tree.

## Zoom surface and label evidence

Fathom recognizes `AXStandardWindow`, system/application dialogs, Zoom video
render/floating/share surfaces, localized computer-audio states, and explicit
active-speaker labels. Its installed binary contains English, Spanish, and
French active-state grammars, including `Talking`, `Hablando`, and the French
equivalent.

The local Fathom log also demonstrates that Zoom floating surfaces may report
`Role: AXWindow` with `Subrole: AXSystemDialog`. Rowboat must inspect both role
and subrole; otherwise that small overlay is incorrectly counted as a second
primary meeting window.

Rowboat intentionally remains narrower than Fathom:

- exactly one validated primary meeting surface is required;
- a dialog can contribute only an explicit active-speaker assertion;
- editable values and arbitrary roster labels are excluded;
- multiple plausible meeting windows produce no name;
- diagnostics contain counts/status only, never labels, names, titles, bounds,
  PIDs, audio, or transcript text.

## Qualification

Static evidence proves Fathom uses this technique; it does not prove the
technique works on every Zoom release. Before production enablement, qualify a
real consenting two-person call in foreground, background, minimized, floating
window, and screen-share states. Exercise local speech, remote speech,
mute/idle transitions, overlapping speech, permission revoke/regrant, and Zoom
restart. Preserve overlap or unknown output when evidence is insufficient;
never guess a participant from a roster or audio activity alone.
