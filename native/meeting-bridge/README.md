# meeting-bridge

`meeting-bridge` is a standalone Rust sidecar for the Rowboat desktop app. It
owns local microphone/system capture lifecycle and bounded platform evidence;
it does **not** contain an ASR model, diarizer, LLM, calendar client, or any
renderer-facing PCM path.

## Safety boundary

Electron main starts and supervises this binary over a private NDJSON stdio
pipe. Control, health, and normalized speaker-evidence records contain no PCM.
The one explicit exception is the opt-in AEC request: Electron main sends one
bounded, paired 20 ms mic/render frame and receives ordered replacement mic
frames on that same private pipe. PCM is never exposed through renderer IPC,
logged, persisted, placed in diagnostics, or sent to the VPS by the helper.
Electron main alone delivers the cleaned-or-raw mic result and the independent
system channel to ASR. API credentials, Accessibility trees, transcripts, and
user note text never enter the sidecar.

`Ready` has a strict meaning: the source has opened **and** a non-empty valid
PCM callback has produced a normalized 20 ms frame. A buffer full of zeroes is
valid silence. An open handle with no callbacks remains `Starting` or
`Recovering`.

The optional `anarlog-ax` alpha is evidence-only: it can emit a bounded Zoom
`speaker_evidence` record but cannot open, replace, pause, route, or otherwise
claim anything about Rowboat audio capture. A speaker-evidence failure is
explicitly separate from capture health.

## Local contract

Each channel is independent and uses 16 kHz mono fixed 20 ms frames (320
signed-16-bit samples):

```text
AudioFrame { meeting_id, source_id, channel, start_sample, sample_count,
             sample_rate, sequence, epoch, flags, pcm_s16le }
CaptureHealth { channel, state, sequence, last_frame_sample, restart_count }
```

The next frame after an input gap, source reopen, or bounded queue overflow is
flagged `discontinuity`; a verified reopen also has `recovered`. Downstream ASR
must begin a new interval/epoch rather than joining text prefixes across it.

The `DualCapture` coordinator starts mic and system sources before waiting for
either callback. That is the specific safeguard for a user speaking for ten
minutes before a remote participant speaks.

## Build and verify

```sh
cd native/meeting-bridge
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

# macOS-only Zoom Accessibility provider; compile and fixture-test it explicitly.
cargo clippy --all-targets --features anarlog-ax -- -D warnings
cargo test --features anarlog-ax
```

The default build has no audio backend dependency, which keeps protocol and
supervisor tests portable:

```sh
cargo run
# emits {"type":"ready","protocol_version":1}
printf '%s\n' '{"type":"ping","request_id":"smoke"}' | cargo run
```

## Optional acoustic echo cancellation qualification

The bridge now owns the safe AEC timing boundary: it aligns bounded render and
microphone histories, processes only timestamp-qualified speaker-output pairs,
preserves near-end/double-talk mic frames, and passes raw mic through on
headsets, missing/untrusted references, source gaps, processor failure, or the
incomplete reblocking tail. `AecHealth` and per-frame metadata are safe for
Electron main; neither contains PCM, text, paths, or a quality score.

Two implementation candidates remain opt-in, independent comparisons:

```sh
# Generic bridge/reblocker policy and the dynamically loaded LocalVQE adapter.
cargo test --features aec-localvqe

# Bundled BSD-3-Clause WebRTC AudioProcessing v2.1 AEC3 comparator.
# Requires the reviewed native toolchain (meson, ninja, pkg-config/pkgconf).
cargo test --features aec-webrtc-aec3
```

`aec-localvqe` pins the Apache-2.0 LocalVQE source and v1.4-AEC 200K model but
does not ship either. Electron main supplies explicit local library/model paths
only for a qualification session; the adapter canonicalizes both and verifies
the model SHA-256 before dynamically loading the narrow C ABI. LocalVQE uses
256-sample hops, AEC3 uses 160-sample hops, and the bridge uses 320-sample
capture frames. `StreamingReblocker` preserves sample order and adds bounded
startup latency instead of pretending these are same-frame APIs.

The current Rowboat alpha captures PCM through the renderer fallback, pairs
the two channels in Electron main, and—only in the contributor AEC package—
constructs an `AecCoordinator` and routes bounded pairs through this sidecar.
Missing resources, untrusted timing, helper errors, or disabled gates release
the original mic samples raw. Do not claim AEC quality merely because this
operational path builds or passes silent-frame tests.
See [`vendor/localvqe/MANIFEST.md`](vendor/localvqe/MANIFEST.md) and
[`vendor/webrtc-aec3/MANIFEST.md`](vendor/webrtc-aec3/MANIFEST.md) for pins,
licenses, SBOM evidence, and physical promotion gates.

## FlexAudio A/B adapter

The optional `flexaudio` feature pins the MIT project to
`7e41bbd0b03c4f52260926fa0148ca0e0179fda1`:

```sh
cargo check --features flexaudio
```

The adapter requests one source per stream (mic, per-process system audio, or
global system fallback) at 16 kHz mono. The process-first policy is separate
from readiness: it tries a detected meeting PID then a global output source
excluding the bridge process, and periodically re-tests the process source.

Do **not** make FlexAudio the default capture backend until all of these pass:

1. a macOS source timestamp patch is present or the source timing remains
   explicitly lower-confidence;
2. macOS and Windows device-change events are available (the audited revision
   has a Linux-only active watcher);
3. forced device/process loss produces `Stalled`, `Recovering`, then `Ready`
   only after a real post-reopen frame; and
4. the legacy Rowboat path wins neither latency nor no-gap acceptance tests.

To roll back, select Rowboat's existing capture adapter; the Frame/Health
contracts and VPS transport do not change.

## Anarlog evidence boundary

The optional macOS `anarlog-ax` feature includes
`evidence::MacosZoomAnarlogProvider`, a small MIT-licensed adaptation of
Anarlog's bounded `meeting_ax` Zoom inspection. Its exact upstream revision,
license, source checksums, retained limits, exclusions, dependency choices,
and physical qualification gate are in
[`vendor/anarlog-meeting-ax/MANIFEST.md`](vendor/anarlog-meeting-ax/MANIFEST.md).

It performs a non-prompting Accessibility trust check, looks up only the
native Zoom bundle (`us.zoom.xos`), best-effort enables Zoom's manual/enhanced
Accessibility application surface, applies Anarlog's 0.6-second AX messaging
timeout and 18-depth/1,800-node limits, and emits a name only from an explicit
active-speaker label. Enhancement attempts are Zoom-only and cached per PID for
five minutes; failure cannot block audio or create evidence. Multiple plausible
Zoom windows, inaccessible trees, generic labels, and roster-only rows produce
no active-speaker claim. The provider never scans browser tabs or reads
editable input values. The behavior-level provenance and intentional
differences from Fathom are in
[`FATHOM_INTEROP_RESEARCH.md`](FATHOM_INTEROP_RESEARCH.md).

The feature compiling is not permission to enable it in a user build. It still
requires the real macOS TCC/Zoom qualification listed in the manifest, and
Electron main must own the permission UX and construct the source only after
that gate passes.

### Evidence-only alpha control flow

On **macOS only**, a build with `--features anarlog-ax` treats a `start`
command as an evidence-only session. It creates the `MacosZoomAnarlogProvider`,
polls at most once every 250 ms, and emits only strict native-Zoom,
explicit-active-speaker records. It deliberately does not emit an audio-frame,
capture-health, or `Ready` event as a side effect. `stop` for the same meeting
ends the evidence session.

One Accessibility point never creates a speaker interval. The host retains it
only as a baseline; after the next poll, it emits the already-observed interval
between two matching named-active observations, only when that interval is
200–750 ms. This avoids inventing future speech while satisfying the resolver's
200 ms overlap requirement. Any missing, inactive, generic, wrong-meeting, or
pre-existing observation resets continuity and is discarded before stdout.

The command reader and AX poller communicate through a 32-command bounded
channel; the main loop is the sole stdout writer and sleeps until either a
command or the next poll deadline. Permission or backend failure stops the
evidence session and emits one bounded error; it never leaves stale speaker
evidence active or retries in a tight loop.

For a terminal-only physical qualification, set
`ROWBOAT_MEETING_BRIDGE_AX_DIAGNOSTICS=1` before starting a feature-enabled
helper. It writes a changed-state summary to stderr with Accessibility trust,
process/surface counts, and validation outcome only. It never prints AX labels,
speaker names, window titles, values, bounds, or process identifiers. This
diagnostic is not forwarded by Electron and is off unless explicitly set.

Default/non-macOS builds retain the existing fail-closed `start` response:
`source_configuration_required`. Electron main must continue using Rowboat's
selected capture path for audio. Do not enable this alpha in a package until
the TCC and physical Zoom tests in the source manifest have passed.

The adapter never makes evidence up. It accepts participant/active-speaker data
from a real provider, bounds it to 64 observations and 8 short signals, drops
screen layout/AX trees, and retains `is_active = None` for roster-only rows.
Calendar, contacts, emails, and attendee inference are not part of this bridge.

## Electron-main integration

1. Package the platform bridge binary as a native resource alongside the
   Electron main process. Do not execute it from the renderer.
2. Electron main creates a private stdin/stdout pipe, sends a `start` command,
   and chooses a concrete `AudioSource` based on the signed local config.
   Secrets are passed once over this private channel, never as command-line
   arguments or logs.
3. Main receives `CaptureHealth`, audio-frame metadata, backpressure, and
   bounded `SpeakerEvidence`; it streams PCM directly via the authenticated VPS
   transport and projects structured transcript revisions into the renderer.
4. On three failed recoveries inside one minute, main terminates and recreates
   the sidecar while retaining all final transcript records.
5. Windows uses the same trait/policy: WASAPI process loopback first, then
   global loopback excluding the bridge process. Build artifacts are
   target-gated until a Windows physical acceptance packet exists.

The current binary is intentionally an audio-protocol smoke-test host. Electron
main must construct audio sources through the library; this prevents an
unreviewed command from selecting devices, sending secrets, or creating an
accidental renderer audio path. The macOS `anarlog-ax` alpha is the narrow
exception for **evidence only**, and still requires Electron main to own its
feature flag, TCC UX, and physical qualification gate.
