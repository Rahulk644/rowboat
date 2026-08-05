# Meeting-capable Rowboat on macOS

Use the repository-local path below for physical meeting testing. It packages a
real `Rowboat.app`; do not launch `electron .` or a copied Electron binary,
because macOS would grant Accessibility to that temporary generic identity.

```sh
mkdir -p ~/.rowboat/config
chmod 700 ~/.rowboat ~/.rowboat/config
cat > ~/.rowboat/config/meeting-transcription.env
# ROWBOAT_MEETING_STT_URL=http://127.0.0.1:18091
# ROWBOAT_MEETING_STT_TOKEN=<your 32+-character tunnel token>
chmod 600 ~/.rowboat/config/meeting-transcription.env

./script/build_and_run.sh --verify
./script/build_and_run.sh
```

The launcher accepts only the two listed keys; it does not source the file as
shell code. The file remains outside the checkout, requires owner-only access,
and its token stays in Electron main rather than the renderer or native helper.

The helper is built from source and packaged at:

```text
Rowboat.app/Contents/Resources/meeting-bridge/darwin/meeting-bridge
```

`--verify` checks the distinct `com.rowboat.meetings-dev` bundle identifier,
sealed contributor marker, helper location, regular/executable file mode, and
code signatures before any launch. The package is visibly named **Rowboat
Meetings Dev**, uses its own Chromium profile and single-instance lock before
startup, and does not register `rowboat://`. It therefore cannot silently exit
into or exercise `/Applications/Rowboat.app`. Grant Accessibility to
**Rowboat Meetings Dev** in System Settings; there is no temporary
Electron identity in this flow. An ad-hoc signature has a rebuild-sensitive
designated requirement, so macOS can ask you to approve Rowboat again after a
rebuild. `--logs`, `--telemetry`, and `--debug` run the same packaged bundle.

If the two `ROWBOAT_MEETING_STT_*` variables are not explicitly exported and
there is no owner-only config file, the launcher reads the existing macOS
Keychain item with service `com.myassistant.desktop.meeting-transcription` and
account `private-server`; it never prints the password. That item is for the
loopback tunnel at `http://127.0.0.1:18091`. This is a local developer/test
convenience, not a packaged-app credential mechanism.

## Signing boundary

Contributor builds use Forge's recursive ad-hoc signer for local TCC
qualification only. They are neither Developer ID signed nor notarized and
must not be distributed. Set `ROWBOAT_LOCAL_SIGNING_IDENTITY` to a locally
installed signing identity when you need a stable local identity; the release
workflow still requires a Developer ID Application certificate and Apple
notarization credentials.

### Stable contributor install (required for durable TCC approval)

macOS grants Screen Recording, Accessibility, and microphone access to an
app's **designated code requirement**, not to its display name or bundle ID
alone. The installed release `/Applications/Rowboat.app` is signed by the
Rowboat Developer ID team. A locally ad-hoc-signed build has a
build-specific `cdhash` requirement, so it cannot reuse that release grant and
it loses its own grant after a code-changing rebuild.

For repeated physical tests, use an Apple Development or Developer ID
Application certificate owned by the contributor. This does not modify the
release app, the contributor's Keychain, or TCC database:

```sh
# Inspect identities; select an Apple Development or Developer ID Application
# identity from this local list. Do not paste certificates or private keys.
security find-identity -v -p codesigning

ROWBOAT_LOCAL_SIGNING_IDENTITY='Apple Development: Your Name (YOURTEAMID)' \
./script/build_and_run.sh --stable-install
```

The installer validates the signed bundle before and after copying it to:

```text
~/Applications/Rowboat Meetings Dev.app
```

It never writes to or replaces `/Applications/Rowboat.app`, never launches the
app, and refuses to replace a prior contributor bundle by default. Open this
exact `~/Applications` bundle from Finder, start a meeting capture, then grant
the macOS prompts to its contributor-signed Rowboat entry. On a deliberate
upgrade, retain the same certificate/team and use:

```sh
ROWBOAT_LOCAL_SIGNING_IDENTITY='Apple Development: Your Name (YOURTEAMID)' \
ROWBOAT_CONTRIBUTOR_REPLACE=1 \
./script/build_and_run.sh --stable-install
```

The replaced contributor copy is moved to a recoverable
`~/Applications/.rowboat-meeting-backups/` directory; it is not deleted. The
stable-install gate rejects ad-hoc signatures and any bundle without a Team ID.
Certificate/team changes (including moving between an Apple Development and a
Developer ID identity) are a new TCC identity and require a fresh user grant.
Do not attempt to edit, copy, or reset macOS's TCC database to work around
this boundary.

## AEC asset gate

The normal bridge package does not include LocalVQE. For a physical opt-in
qualification build only, set all three explicit variables before running the
launcher:

```sh
ROWBOAT_MEETING_AEC_ALPHA=1 \
ROWBOAT_LOCALVQE_DYLIB_PATH=/absolute/path/to/liblocalvqe.0.1.0.dylib \
ROWBOAT_LOCALVQE_MODEL_PATH=/absolute/path/to/localvqe-v1.4-aec-200K-f32.gguf \
./script/build_and_run.sh
```

The stage path accepts only canonical regular files, requires the reviewed
v1.4-AEC 200K model SHA-256
`b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731`, and
copies them beside the helper. Forge refuses this flag outside the distinct
contributor bundle ID, then discovers and signs the dylib as a nested
code object; the helper derives only those adjacent packaged paths itself. It
never copies a binary or model into Git. This is a developer qualification
path, not a distributable asset policy. Promotion to a release requires an
approved platform dylib checksum plus reproducible build/SBOM evidence; the
model checksum alone does not authenticate native code.

The same AEC qualification build includes the WebRTC AEC3 comparator. Its two
Abseil Meson-wrap downloads live only in the ignored
`native/meeting-bridge/target/meson-package-cache/` cache, are checked against
the pinned wrap hashes before use, and are reused offline after the first
verified fill. They are never staged into `Rowboat.app` or committed.

On a normal Finder launch, Electron main enables the bridge only when the
packaged helper exists and enables LocalVQE only when both fixed signed assets
are present. A normal package without those resources stays off; neither path
depends on exported wrapper flags.
