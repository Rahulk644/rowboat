# Meeting transcription providers

Rowboat captures microphone and system audio in the renderer, but provider credentials and network transport
belong to the Electron main process. The renderer sends bounded PCM batches over validated IPC and receives
provider-neutral transcript snapshots.

## Providers

- **Deepgram** remains the default and preserves the existing Rowboat account/API-key flow.
- **Self-hosted Nemotron** is selected when both environment variables below are present. It uses one remote
  model with separate named microphone and system-audio sessions.

```sh
ROWBOAT_MEETING_STT_URL=http://127.0.0.1:18091
ROWBOAT_MEETING_STT_TOKEN=<random bearer token of at least 32 characters>
```

The URL is deliberately restricted to HTTP loopback. Production remote access should terminate through a
restricted SSH tunnel or qualified private VPN; Rowboat will not send the bearer token to an arbitrary public
host. The token is read only by the main process and never returned over IPC.

## Audio and recovery contract

- Input is 16 kHz mono signed-16 PCM, batched at 560 ms per source.
- `mic` and `system` are independent source channels. They are not participant identities: microphone is
  labelled `You`, while mixed playback is conservatively labelled `Remote participant` until a separate
  evidence/diarization layer can justify a name.
- Requests are serialized because the qualified CPU worker shares one loaded model and one compute lane.
- A transient connection failure restarts both streaming sessions and replays the uncommitted channel pair.
- Pending audio is bounded to 24 pairs (13.44 seconds). Rowboat reports a degraded live transcript and drops
  new batches rather than allowing an outage to grow renderer memory without limit.
- Finalization flushes both streams and resets their remote session slots.

## Opt-in live PCM diagnostics

For a physical self-hosted capture investigation, launch the dev app with
`ROWBOAT_MEETING_PCM_DIAGNOSTICS=1`. Alternatively, enable counters only from the current point in an active
session through the renderer DevTools console:

```js
await window.ipc.invoke('meeting:transcription:pcmDiagnostics', { enable: true })
await window.ipc.invoke('meeting:transcription:pcmDiagnostics', {})
```

The result is ephemeral and contains only per-channel batch/sample counts, a non-silent-batch count, worker
request/response/failure counts, worker progress timings, and emitted-segment counts. It contains no PCM,
audio levels, transcript text, identities, session IDs, tokens, or worker URLs; it is erased on reset or
finalization. A healthy live capture should advance `acceptedBatches`, `workerRequests`, and
`workerResponses` for both `mic` and `system`. `signalBatches` shows that a channel contained aggregate
non-silent PCM, while `emittedSegmentUpserts` can remain zero during silence or before the ASR model commits.

## Remaining production work

Environment configuration is the developer/qualification seam. A settings surface backed by Electron
`safeStorage`, transcript-liveness monitoring, explicit provider status in the in-meeting surface, participant
evidence, and overlap-safe acoustic echo cancellation must land before enabling this provider by default.
