# Third-party notices

## FlexAudio

- Source: <https://github.com/Studio-Sadola/flexaudio>
- Pinned revision: `7e41bbd0b03c4f52260926fa0148ca0e0179fda1`
- License: MIT
- Use: optional cross-platform microphone/system/process capture adapter
- Local patches: none in this repository
- Qualification: disabled by default pending timestamp, device-watch, recovery,
  and physical macOS/Windows acceptance gates described in `README.md`.

## Anarlog

- Source: <https://github.com/fastrepl/anarlog>
- Pinned revision: `609ee772801f29292e4edee453f269089ebf0e8b`
- License: MIT
- Use: optional macOS native-Zoom bounded `meeting_ax` provider only
- Local source manifest: [`vendor/anarlog-meeting-ax/MANIFEST.md`](vendor/anarlog-meeting-ax/MANIFEST.md)
- Included behavior: a narrow adaptation of Anarlog's bounded AX traversal,
  Zoom meeting-window validation, and explicit active-speaker label parser.
  It is compiled only with `--features anarlog-ax` on macOS. Browser paths,
  chat capture/mutation, Calendar, contacts, and all other Anarlog modules are
  excluded.
- Qualification: TCC Accessibility plus a physical native-Zoom participant
  test remains required before this optional provider is enabled in a package.

No proprietary application code, private credentials, sessions, endpoints, or
Calendar-derived identity data are included in this component.

## LocalVQE (optional AEC candidate)

- Source: <https://github.com/localai-org/LocalVQE>
- Audited revision: `f53063c9eb2a85f96479867d1dd911dc3bf6319b`
- License: Apache-2.0
- Initial qualified asset: `localvqe-v1.4-aec-200K-f32.gguf`, SHA-256
  `b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731`
- Use: feature-gated, dynamically loaded 256-sample local AEC processor behind
  the bridge's ordered 320↔256 reblocker
- Included source/assets: none in Git. A contributor-only AEC package may
  stage an explicitly supplied dylib and the hash-verified model; the bridge
  never downloads either asset. The package also seals the full Apache-2.0
  license and LocalVQE copyright notice beside the helper.
- Manifest: [`vendor/localvqe/MANIFEST.md`](vendor/localvqe/MANIFEST.md)

## WebRTC AudioProcessing AEC3 (optional comparator)

- Source: <https://github.com/tonarino/webrtc-audio-processing>
- Audited wrapper revision: `c14d7af1760baff83e8210fee336a0cae0faaa7d`
  (`v2.1.0`); PulseAudio WebRTC submodule `d0569cfa`
- License: BSD-3-Clause
- Use: feature-gated bundled 160-sample AEC3 comparator behind the bridge's
  ordered 320↔160 reblocker
- Package notice: the full upstream BSD-3-Clause license is sealed beside the
  helper in contributor AEC builds.
- Manifest: [`vendor/webrtc-aec3/MANIFEST.md`](vendor/webrtc-aec3/MANIFEST.md)

Neither optional AEC component is enabled by default. Building or smoke-testing
them does not demonstrate echo reduction, near-end preservation, double-talk
quality, or production suitability.
