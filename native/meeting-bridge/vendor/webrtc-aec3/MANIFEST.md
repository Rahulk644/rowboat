# WebRTC AEC3 comparator manifest

The optional `aec-webrtc-aec3` feature uses the bundled source mode of the
Rust `webrtc-audio-processing` wrapper. It is an A/B control for LocalVQE, not
a default audio backend and not a fallback that can rewrite a failed current
LocalVQE frame.

| Item | Value |
| --- | --- |
| Wrapper source | `https://github.com/tonarino/webrtc-audio-processing` |
| Audited wrapper revision | `c14d7af1760baff83e8210fee336a0cae0faaa7d` (`v2.1.0`) |
| PulseAudio WebRTC submodule | `d0569cfa` |
| Rust package | `webrtc-audio-processing = 2.1.0` |
| License | BSD-3-Clause (`COPYING` in the wrapper source) |
| Native mode | `bundled`, never an arbitrary system shared library |
| Sample rate / hop | 16 kHz mono / 160 samples (10 ms) |

The build needs a reviewed native toolchain (including `meson`, `ninja`, and
`pkg-config`/`pkgconf`). The `Cargo.lock` pins the crate graph; release
evidence must additionally capture toolchain versions, built artifact checksums
and linked-library/SBOM output. No model is downloaded or loaded.

`StreamingReblocker` converts 320-sample bridge frames to ordered 160-sample
render-before-capture calls and retains explicit bounded latency. If LocalVQE
fails after consuming any buffered input, Rowboat releases all pending mic
frames raw, resets both engines, and only then promotes AEC3 for a future
timestamp-qualified frame. It never sends the failing frame to a cold AEC3
state, which would misalign echo history.
