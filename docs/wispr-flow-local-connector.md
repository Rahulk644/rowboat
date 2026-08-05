# Wispr Flow local meeting connector

Meetings is **Beta**. This optional macOS connector lets Wispr Flow remain the
meeting recorder/transcriber while Rowboat owns the live note and downstream
LLM/knowledge workflow. It uses no Wispr HTTP API, credentials, session token,
private endpoint, copied application code, or second Rowboat audio capture.

## User journey

1. Open Rowboat **Meetings** and select **Use Wispr Flow** once.
2. Rowboat opens Wispr's Notetaker. No extension installation or restart is
   required; the status becomes `Live · local` when Wispr's local workspace is
   available.
3. Start a Wispr Notetaker meeting through Wispr's automatic call detection or
   its normal meeting shortcut. Rowboat creates and opens the corresponding
   meeting note automatically when Wispr creates its live meeting artifact.
4. Finalized rows are followed from Wispr's durable append log and appear as
   `You`, an evidenced participant name, a stable speaker cluster, or
   `Unknown speaker`. If Wispr enables its feature-gated extension system, the
   optional accelerator can show a provisional `Resolving speaker…` row first
   and revise that same segment when the durable row arrives.
5. Stop normally in Wispr. Its refined transcript is the durable end signal,
   so Rowboat finalizes automatically, imports the final transcript plus any
   locally available Wispr summary, notes, and participant names into a
   separate owned block, then runs Rowboat's selected LLM workflow.

Rowboat does not request microphone or screen-capture permission in this mode.
Wispr remains responsible for capture, echo handling, transcription, meeting
detection, and its own permissions.

## Local architecture

```text
Wispr Notetaker
  ├─ meetings/<id>/live.ndjson (baseline live source/name/timing authority)
  ├─ meetings/<id>/refined.ndjson (post-meeting revisions)
  └─ flow.sqlite (title/notes/summary/participants)
          │
          ▼ read-only
Rowboat Electron main
  ├─ local file watcher + read-only SQLite connection
  ├─ schema/size validation and idempotent revision reconciliation
  ├─ optional owner-only socket extension for lower latency
  └─ canonical transcript-v2 upserts
          │
          ▼
Rowboat meeting note + selected LLM/knowledge workflow
```

The optional accelerator is packaged under
`~/.rowboat/integrations/wispr-flow/extensions/rowboat-notetaker`. Rowboat adds
only that private integration root to Wispr's extension configuration when its
explicit developer install action is used, preserving existing entries. Its
socket and per-launch token live under `~/.rowboat/run` with owner-only
permissions. Wispr Flow 1.6.399 feature-gates the extension system, so normal
operation and correctness do not require the accelerator to load.

The database is opened read-only. Rowboat never modifies Wispr's meeting
database, transcript files, audio, credentials, or settings beyond the two
extension registration files changed only by the optional developer action.

## Deterministic verification

```sh
cd apps/x
npm run typecheck
cd apps/main
npm test
npm run build
```

The main-process tests cover extension registration preservation, the
extension-free local artifact path, provisional delivery, authoritative mic
reconciliation, in-place revision, and the `You` label. Type-checking covers
the validated IPC and renderer provider branch.
`npm run build` must print `Wispr Flow local connector staged`.

## Physical acceptance

Use a consenting two-person call and do not commit transcript/audio evidence.

1. Confirm Meetings shows `Wispr Flow Notetaker · Live · local` (or
   `Live · accelerated` when the optional extension is active).
2. Start Wispr Notetaker and verify Rowboat creates one note without asking for
   Rowboat microphone or screen-capture permission.
3. Speak locally; expect the durable finalized line to appear as `You`. In
   accelerated mode a provisional line may be revised in place first.
4. Have the remote person speak; expect Wispr's evidenced name, otherwise a
   cluster or unknown label—never `You` merely because the name is absent.
5. Repeat one identical phrase and verify it remains two real turns rather
   than one duplicate transport event.
6. Test simultaneous speech, mute/unmute, minimization, screen sharing, and an
   audio-device switch. Rowboat must remain a passive consumer throughout.
7. Stop the call in Wispr and verify Rowboat stops automatically; final text
   revisions and locally available Wispr notes/summary must appear without
   overwriting the scratchpad.

## Compatibility and rollback

The local meeting artifacts and optional extension callback are observable
Wispr seams, not public stable APIs. A Wispr update can change either. Rowboat
therefore version-qualifies the reader, validates every row, and fails closed:
an incompatible reader never falls through to silently start a second
recorder.

Select **Use Rowboat capture** to return to the existing self-hosted/Deepgram
path. This does not delete the connector or any Wispr/Rowboat meeting data.

Current qualification is Wispr Flow 1.6.399 on macOS. Windows needs its own
path and installed-app acceptance before this connector can be labelled
cross-platform.
