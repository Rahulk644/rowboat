# meeting-bridge

`meeting-bridge` is a standalone Rust sidecar for the Rowboat desktop app. It
owns local microphone/system capture lifecycle and bounded platform evidence;
it does **not** contain an ASR model, diarizer, LLM, calendar client, or any
renderer-facing PCM path.

## Safety boundary

Electron main starts and supervises this binary over a private stdio pipe.
The plan allows a length-delimited binary protocol or NDJSON. This foundation
selects newline-delimited JSON for small control and metadata events.
It never serializes audio frames, base64 PCM, API credentials, Accessibility
trees, or user note text. PCM is handed by the bridge directly to the private
authenticated VPS transport selected by Electron main **only after the next
transport slice supplies a private binary `AudioFrame` sink**. The current
standalone binary is a control-protocol smoke-test host and deliberately does
not send or persist audio.

`Ready` has a strict meaning: the source has opened **and** a non-empty valid
PCM callback has produced a normalized 20 ms frame. A buffer full of zeroes is
valid silence. An open handle with no callbacks remains `Starting` or
`Recovering`.

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
```

The default build has no audio backend dependency, which keeps protocol and
supervisor tests portable:

```sh
cargo run
# emits {"type":"ready","protocol_version":1}
printf '%s\n' '{"type":"ping","request_id":"smoke"}' | cargo run
```

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

The `evidence::AnarlogAxSource` maps the fields from Anarlog's bounded
`meeting_ax` inspection into the bridge contract. It is deliberately a provider
interface rather than copied code in this first slice: Anarlog is MIT but its
module is currently workspace-coupled and needs a reviewed vendor manifest,
license notice, and real macOS TCC/Zoom/Meet qualification before shipping.

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

The current binary is intentionally a protocol smoke-test host. Electron main
must construct sources through the library; this prevents an unreviewed command
from selecting devices, sending secrets, or creating an accidental renderer
audio path.
