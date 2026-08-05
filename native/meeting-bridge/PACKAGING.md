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

The macOS plan enables the reviewed `anarlog-ax` feature. In an unpackaged
development process runtime remains opt-in with
`ROWBOAT_MEETING_BRIDGE_ENABLED=1`. A packaged app that contains the sealed
helper enables it by default, while an explicit
`ROWBOAT_MEETING_BRIDGE_ENABLED=0` remains the operator rollback. A normal
package without the helper forces the capability off.

Verify the platform/path plan without invoking Cargo:

```sh
node --test native/meeting-bridge/scripts/stage.test.mjs
```

For a physical macOS contributor build, use the repository-root
`./script/build_and_run.sh --verify`. It sets the package and contributor
identity flags, builds this
helper from source, stages it at the exact runtime resource path above, then
checks the distinct `com.rowboat.meetings-dev` bundle, sealed contributor
marker, and nested executable. It uses its own user-data/single-instance
identity and cannot silently defer to `/Applications/Rowboat.app`. The local bundle is
ad-hoc signed only; its designated requirement can change after a rebuild, so
macOS may require a new Accessibility approval. Release distribution still
requires the Developer ID and notarization credentials described in the
release workflow.

For repeated contributor TCC qualification, do not rely on that ad-hoc bundle
or the release copy in `/Applications`. Sign with the contributor's unchanged
Apple Development or Developer ID Application identity and use the repository
installer instead:

```sh
ROWBOAT_LOCAL_SIGNING_IDENTITY='Apple Development: Your Name (YOURTEAMID)' \
./script/build_and_run.sh --stable-install
```

This verifies a non-ad-hoc Team ID before copying to the separate
`~/Applications/Rowboat Meetings Dev.app` bundle. It never replaces the
release application or alters the macOS TCC database. See
[`docs/MEETING_CONTRIBUTOR_MACOS.md`](../../docs/MEETING_CONTRIBUTOR_MACOS.md)
for the deliberate upgrade path and its recoverable backup behavior.

For an operational LocalVQE qualification package, additionally set
`ROWBOAT_MEETING_AEC_ALPHA=1` and the absolute
`ROWBOAT_LOCALVQE_DYLIB_PATH`/`ROWBOAT_LOCALVQE_MODEL_PATH` inputs. The stage
script canonicalizes both files, requires a regular file, verifies the exact
reviewed model SHA-256, and places fixed resource names beside the helper.
Normal packages have none of these assets. Forge refuses AEC alpha unless the
distinct contributor-build gate is also present, so an arbitrary local dylib
cannot enter the release bundle/signing path. Promotion requires a reviewed
platform dylib checksum, build recipe/SBOM, notices, and the physical corpus;
the model hash alone is not library provenance.

The same AEC alpha build enables the WebRTC AEC3 comparator. Its Meson build
needs Abseil source plus the matching Meson wrap patch. The stage script keeps
those two hash-pinned downloads only in the ignored target-local cache:

```text
native/meeting-bridge/target/meson-package-cache/<rust-target>/
```

It verifies each wrap SHA-256 before use and sets `MESON_PACKAGE_CACHE_DIR`
for Cargo. The first cache fill needs the two reviewed HTTPS downloads; later
builds reuse verified files offline. Do not move either archive into the
repository or `Rowboat.app`.
