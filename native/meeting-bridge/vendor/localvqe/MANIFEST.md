# LocalVQE qualification manifest

This directory intentionally contains no LocalVQE source, shared library, or
model asset. The optional `aec-localvqe` bridge adapter dynamically loads an
explicit local library and model only after both paths are canonical regular
files and the model matches the checksum below. It never downloads an asset.

## Pinned material

| Item | Value |
| --- | --- |
| Source | `https://github.com/localai-org/LocalVQE` |
| Audited revision | `f53063c9eb2a85f96479867d1dd911dc3bf6319b` |
| Source license | Apache-2.0 |
| Initial model | `localvqe-v1.4-aec-200K-f32.gguf` |
| Model SHA-256 | `b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731` |
| C ABI | `localvqe_new`, `localvqe_free`, `localvqe_process_frame_s16`, `localvqe_reset`, `localvqe_sample_rate`, `localvqe_hop_length` |
| Sample rate / hop | 16 kHz mono / 256 samples |

The library must be built from that revision, including its reviewed `ggml`
submodule. Before a package includes it, record the platform build recipe,
shared-library checksum, linked-library/SBOM output, and license notice in the
release evidence. A model checksum alone does **not** authenticate a dynamic
library.

## Streaming boundary

The native bridge uses 320-sample/20 ms capture frames. LocalVQE's frame API
accepts exactly 256 samples; its whole-clip API is not a replacement because
it resets/handles stream state differently. `StreamingReblocker` queues
aligned mic and render samples, invokes LocalVQE only for complete 256-sample
hops, and returns only sample-ordered output. The coordinator delays a mic
frame until it has a complete 320-sample cleaned result. It releases an
incomplete tail raw on stop, discontinuity, reference loss, or processing
failure—never zero-pads, truncates, or labels a delayed result as same-frame.

## Enablement and rollback

`aec-localvqe` is off by default. Its qualification-only configuration uses
two Electron-main/private-host values:

```text
ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY=/absolute/path/to/liblocalvqe
ROWBOAT_MEETING_AEC_LOCALVQE_MODEL=/absolute/path/to/localvqe-v1.4-aec-200K-f32.gguf
```

These values must not reach the renderer, a transcript, diagnostics, command
line, or Git. Upstream LocalVQE may write its own model/backend initialization
messages to stderr; the packaged bridge supervisor must not forward raw native
stderr to the renderer or user telemetry. Disable the feature or omit either
value to return to raw microphone pass-through. AEC cannot stop audio capture.

## Promotion gates

Feature compilation or a silent-hop smoke test is not an AEC quality claim.
Promotion needs the same consented speaker/headset corpus for LocalVQE, AEC3,
and raw: far-end-only echo, near-end-only speech, double-talk, changing delay,
missing reference, device switch, dropout/restart, minimization, 45-minute
soak, CPU/RSS, and false-`You` rate. Preserve both streams during overlap and
fail open to raw mic whenever timing/processing is not qualified.
