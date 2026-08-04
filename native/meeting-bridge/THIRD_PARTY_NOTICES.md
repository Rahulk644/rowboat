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
