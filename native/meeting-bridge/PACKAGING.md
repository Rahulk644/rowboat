# Alpha package staging

The meeting bridge is excluded from normal Rowboat packages. Build an alpha
artifact only by setting this exact flag before Electron Forge:

```sh
cd apps/x/apps/main
ROWBOAT_MEETING_BRIDGE_ALPHA=1 npx electron-forge package --platform=darwin --arch=arm64
```

The staging script accepts only the fixed `darwin`, `win32`, and `linux`
platform maps and supported `arm64`/`x64` targets. It invokes Cargo with an
argument vector rather than a shell command and stages exactly one binary at:

```text
.package/resources/meeting-bridge/<platform>/meeting-bridge[.exe]
```

Forge copies that directory as an `extraResource`, yielding the runtime path:

```text
process.resourcesPath/meeting-bridge/<platform>/meeting-bridge[.exe]
```

The macOS plan enables the reviewed `anarlog-ax` feature. This build flag only
includes the helper; it does not enable runtime execution. Runtime remains
opt-in with `ROWBOAT_MEETING_BRIDGE_ENABLED=1`.

Verify the platform/path plan without invoking Cargo:

```sh
node --test native/meeting-bridge/scripts/stage.test.mjs
```
