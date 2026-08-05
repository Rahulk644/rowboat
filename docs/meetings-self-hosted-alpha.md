# Self-hosted meetings alpha

Meetings is **Beta**. This guide tells contributors how to qualify the
self-hosted meeting path without over-claiming what is currently shipped.

## User journey

1. The user starts meeting notes in Rowboat's existing meeting view; it creates
   the note and shows readiness there. There is no second overlay or Nub.
2. Mic and meeting/system capture start independently at T0. A silent remote
   participant never delays local capture.
3. The note shows revisioned transcript records. Labels are `You`, a directly
   evidenced person, an anonymous cluster, an overlap state, or
   `Unknown speaker`—never a Calendar/attendee guess.
4. On Stop, both ASR sessions flush before Rowboat invokes the selected
   LLM/provider for notes. LLM work is outside the audio critical path.

The branch has the v2 transcript domain and a Rust bridge lifecycle/evidence
sidecar. **Current alpha PCM capture remains the existing renderer
getUserMedia/ScreenCaptureKit path** and is the active rollback path. The
bridge may be built, packaged, and enabled for lifecycle plus optional macOS
Anarlog evidence; native FlexAudio PCM transport remains opt-in foundation
work. This is not a production release.

## Architecture and boundaries

```text
Renderer (current):  meeting UI plus existing mic/system PCM capture fallback
Electron main:       owns STT credential, supervises bridge, merges revisions
Rust bridge:         lifecycle plus optional bounded macOS AX evidence
Private VPS:         one resident Nemotron model, mic + system ASR sessions,
                     globally serialized inference
```

- The renderer never receives the STT token or scans Accessibility. It does
  currently own the legacy capture path until native capture is qualified.
- The bridge has no ASR model, diarizer, LLM, Calendar, contacts, or public
  renderer-facing PCM API. When native audio capture is selected, its audio
  readiness contract requires a first valid callback, not an open handle. The
  current evidence-only sidecar's lifecycle handshake is not audio readiness.
- KVM 1 keeps one model loaded and two named sessions; serialized compute is
  intentional. Do not start a second model process.
- Tokens and control data use private local channels. Do not put credentials in
  command arguments, logs, note text, or an extension message.

Segments are idempotent by `(segmentId, revision)`; a gap starts an epoch.
The current worker returns text prefixes, so emitted interval timing is
intentionally `low` confidence with `timingSource: "feed-window"`, not a
claim of token timestamps. The renderer groups safe contiguous chunks into a
single visible speaker turn while retaining every raw record. Mic copies of
system speech are removed only when shared, conservative time/text evidence is
unique; different concurrent speech is retained. This is reconciliation, not
a claim of acoustic echo cancellation.

Speaker trust order is explicit correction; qualified healthy mic for `You`;
dominant active Accessibility evidence; confirmed voice profile clearing both
threshold and runner-up margin; anonymous stable cluster; unknown. Passive
rosters do not name a turn. Simultaneous active people are overlap, not a
fabricated word split.

## KVM and SSH tunnel

Rowboat permits only a loopback HTTP STT URL. Reach the private VPS through a
restricted SSH tunnel (or equivalent private VPN); never publish the service.

```sh
# Keep this process alive. Replace only the final hostname/alias; do not type
# angle brackets because zsh interprets them as redirection.
ssh -N -L 127.0.0.1:18091:127.0.0.1:18091 restricted-vps-alias

# Set only in the shell launching Rowboat.
export ROWBOAT_MEETING_STT_URL=http://127.0.0.1:18091
export ROWBOAT_MEETING_STT_TOKEN='<generated-token-at-least-32-characters>'
```

The server contract is in
[MEETING_TRANSCRIPTION.md](../apps/x/MEETING_TRANSCRIPTION.md): mono 16 kHz
signed-16 PCM, one model, and two named sessions. Do not commit these values,
record them in a terminal capture, or include them in an issue. Stop the tunnel
after qualification.

## Build and deterministic checks

```sh
cd apps/x
pnpm install --frozen-lockfile
pnpm run shared
pnpm run core
cd apps/main && npm test
```

The focused tests cover interval epochs, idempotent revisions, delayed
evidence, cross-channel ASR lag, deferred attribution delivery, and the
Calendar-free resolver. They do not prove a physical meeting.

Build the Rust bridge separately:

```sh
cd native/meeting-bridge
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run
printf '%s\n' '{"type":"ping","request_id":"smoke"}' | cargo run
```

The default binary emits a ready event and answers ping. It does not prove mic,
system audio, Zoom, macOS TCC, or a two-person call.

For an opt-in Electron package that stages the helper at the runtime path, use
the deterministic [alpha packaging guide](../native/meeting-bridge/PACKAGING.md).
Normal Rowboat packages remain unchanged unless the explicit build flag is set.

### FlexAudio A/B

FlexAudio is optional and off by default:

```sh
cd native/meeting-bridge
cargo check --features flexaudio
cargo test --features flexaudio
```

It is an A/B adapter, not production approval. Retain the existing Rowboat
capture path as the one-change rollback until timestamp, device-change,
post-reopen readiness, and physical acceptance gates pass.

### Optional Anarlog AX evidence

The optional `anarlog-ax` feature packages the bounded macOS Zoom Anarlog
provider and sends **evidence only** to Electron main; it does not capture PCM
or decide a speaker name on its own:

```sh
cd native/meeting-bridge
cargo test --features anarlog-ax
cargo clippy --all-targets --features anarlog-ax -- -D warnings
```

Use the pinned vendor manifest and notices. Do not replace the provider with
window titles, participant rosters, Calendar, contacts, or email. The feature
is not proof of macOS TCC, Zoom precision, Meet coverage, or physical
acceptance; those remain explicit qualification work.

## Feature gates and rollback

| Capability | Alpha state | Enable gate | Rollback |
|---|---|---|---|
| Self-hosted Nemotron | Both loopback env vars select it | tunnel + KVM health | remove either env var |
| Transcript v2 | main-process domain | revision-aware UI + tests | legacy snapshot fields retained |
| FlexAudio | Cargo feature only | timestamp/device/recovery physical A/B | existing capture adapter |
| Anarlog AX | optional evidence-only macOS feature | package + TCC/Zoom physical test | disable feature; no AX names |
| Voice profiles/diarization | not alpha | consent/privacy/scheduling/accuracy | anonymous or unknown |

## Privacy and provenance

Calendar identity is explicitly excluded: no Calendar permission,
attendee-to-speaker mapping, email/contact lookup, or Calendar-derived capture
or readiness decision.

Do not log Accessibility trees, screen coordinates, unrelated UI text, tokens,
PCM, transcripts, or user-authored notes. Main retains only capped normalized
speaker evidence briefly so AX observations received before ASR can revise the
right interval. A correction is meeting-local by default; reusable voice
enrollment requires separate unchecked consent, owner-private storage,
provenance, revocation, and delete UI. `rememberVoice` does not store a voice
in this alpha.

Component source/license state is in
[THIRD_PARTY_NOTICES.md](../native/meeting-bridge/THIRD_PARTY_NOTICES.md) and
the bridge [README](../native/meeting-bridge/README.md). FlexAudio is pinned to
`7e41bbd0b03c4f52260926fa0148ca0e0179fda1` (MIT). Anarlog is recorded through
the bridge's pinned vendor manifest and notices; it supplies bounded evidence
only, never Calendar-derived identity. Do not add proprietary code,
credentials, private sessions, or endpoints.

## Physical Zoom acceptance script

Use consenting participants. Keep only privacy-safe pass/fail, timing, health,
and revision counts; never commit audio, transcript text, screens, or PII.

1. **Preflight:** checks pass, tunnel runs, Zoom native is selected, and mic +
   Accessibility permissions are granted.
2. **Local first:** user speaks for two minutes while remote is silent.
   Expect mic at T0, no initial gap, and no dependency on system callbacks.
3. **Remote first:** remote speaks for two minutes. Expect system transcript,
   never `You`; absent direct evidence stays unknown.
4. **Akbar then Parminder:** each speaks alone for five seconds. If Zoom AX
   actually exposes that participant's direct active-speaker label, expect it
   only on the qualifying interval. Otherwise leave the text unknown; roster
   presence does nothing.
5. **Overlap:** both remote people speak, then the user joins. Expect both
   audio channels retained. Mark overlap only when simultaneous trusted
   evidence exists; otherwise leave the remote output unknown or show its one
   observed name. Never force a word-perfect individual split. System activity
   must not gate mic audio.
6. **Dropout:** change output device or lose/restore selected capture process.
   Expect `Stalled` → `Recovering` → `Ready` only after a real callback,
   a discontinuity epoch, and prior final text intact.
7. **Tunnel failure:** stop tunnel briefly. Expect bounded backlog/degraded
   state, no local ASR/LLM fallback, and no cross-epoch text on recovery.
8. **Stop:** both sessions flush; notes run after transcript; scratchpad edits
   are not overwritten by transcript revisions.

Unit tests do not substitute for this script. Record physical evidence outside
Git and do not claim unobserved coverage.

## Honest limitations and Windows handoff

- Prefix-derived timing is not word timing.
- Native FlexAudio PCM transport is not active default; renderer capture is the
  current fallback and native transport remains qualification work.
- Optional Anarlog AX is evidence-only macOS Zoom support; no physical
  Zoom/TCC precision claim or browser/Chrome extension support is shipped.
- One mixed remote channel cannot guarantee word-perfect separation of
  simultaneous remote speakers. Preserve overlap; do not falsely name text.
- Calendar identity, reusable voice profiles, final-pass diarization, FlexAudio
  default, and Windows runtime acceptance are not shipped.

For Windows, keep `AudioSource`, `AudioFrame`, `CaptureHealth`, epochs,
revision protocol, and resolver unchanged. Implement WASAPI process loopback
for the detected meeting process first, then global loopback excluding
Rowboat/bridge only when necessary. Emit identical verified-ready,
stalled/recovering, discontinuity, and bounded-queue events.

Windows remains target-gated until a Windows contributor builds/packages the
bridge and runs the complete Zoom script, including output-device switch and
capture-process restart. macOS tests or FlexAudio compilation do not establish
Windows support.
