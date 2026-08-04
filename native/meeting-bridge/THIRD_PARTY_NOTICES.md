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
- Intended pinned revision: `609ee772801f29292e4edee453f269089ebf0e8b`
- License: MIT
- Use: future macOS bounded `meeting_ax` provider only
- Status: not yet vendored or linked. This crate has an adapter contract only;
  copying/adding the module requires its license text, exact source manifest,
  checksum, local patch list, and TCC qualification first.

No proprietary application code, private credentials, sessions, endpoints, or
Calendar-derived identity data are included in this component.
