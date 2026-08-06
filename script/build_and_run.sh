#!/usr/bin/env bash
set -euo pipefail

# Build a real Rowboat.app for meeting qualification. Do not launch the raw
# Electron binary: macOS would register a transient "Electron" Accessibility
# client instead of a Rowboat bundle. An ad-hoc signature is still tied to one
# build's cdhash, so it cannot retain TCC approval across code changes or share
# the approval held by a Developer-ID-signed /Applications/Rowboat.app. Use
# --stable-install with an Apple signing identity for a persistent contributor
# test install under ~/Applications.

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_DIR="$ROOT_DIR/apps/x/apps/main"
VERIFY_SCRIPT="$ROOT_DIR/script/verify_meeting_package.mjs"
CONTRIBUTOR_INSTALL_SCRIPT="$ROOT_DIR/script/install_contributor_macos.mjs"

case "$MODE" in
  run|--run|--full|full|--package|package|--verify|verify|--stable-install|stable-install|--logs|logs|--telemetry|telemetry|--debug|debug) ;;
  *)
    echo "usage: $0 [run|--full|--package|--verify|--stable-install|--logs|--telemetry|--debug]" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This meeting app entrypoint packages the macOS Rowboat bundle. Use the platform CI package flow for Windows/Linux." >&2
  exit 1
fi

if [[ "$MODE" == "--stable-install" || "$MODE" == "stable-install" ]]; then
  [[ -n "${ROWBOAT_LOCAL_SIGNING_IDENTITY:-}" ]] || {
    echo "--stable-install requires ROWBOAT_LOCAL_SIGNING_IDENTITY set to an Apple Development or Developer ID Application signing identity." >&2
    exit 1
  }
  [[ "${ROWBOAT_LOCAL_ADHOC_SIGNING:-}" != "1" ]] || {
    echo "--stable-install cannot be combined with ROWBOAT_LOCAL_ADHOC_SIGNING=1." >&2
    exit 1
  }
fi

case "$(uname -m)" in
  arm64) TARGET_ARCH="arm64" ;;
  x86_64) TARGET_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

APP_BUNDLE="$MAIN_DIR/out/Rowboat Meetings Dev-darwin-$TARGET_ARCH/Rowboat Meetings Dev.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/Rowboat Meetings Dev"
BRIDGE_EXECUTABLE="$APP_BUNDLE/Contents/Resources/meeting-bridge/darwin/meeting-bridge"
AEC_LIBRARY_RESOURCE="$APP_BUNDLE/Contents/Resources/meeting-bridge/darwin/liblocalvqe.0.1.0.dylib"
AEC_MODEL_RESOURCE="$APP_BUNDLE/Contents/Resources/meeting-bridge/darwin/localvqe-v1.4-aec-200K-f32.gguf"
KEYCHAIN_SERVICE="com.myassistant.desktop.meeting-transcription"
KEYCHAIN_ACCOUNT="private-server"
DEFAULT_STT_URL="http://127.0.0.1:18091"

have_complete_environment() {
  [[ -n "${ROWBOAT_MEETING_STT_URL:-}" && -n "${ROWBOAT_MEETING_STT_TOKEN:-}" ]]
}

reject_partial_environment() {
  if [[ -n "${ROWBOAT_MEETING_STT_URL:-}" || -n "${ROWBOAT_MEETING_STT_TOKEN:-}" ]]; then
    echo "Set both ROWBOAT_MEETING_STT_URL and ROWBOAT_MEETING_STT_TOKEN, or neither to use the secure config/Keychain fallback." >&2
    exit 1
  fi
}

load_meeting_environment() {
  configure_packaged_aec_environment

  # An explicitly exported pair is the deliberate, highest-priority
  # configuration. Do not replace it with a file or Keychain value.
  if have_complete_environment; then
    return 0
  fi
  reject_partial_environment

  local config_path="${ROWBOAT_MEETING_CONFIG_FILE:-$HOME/.rowboat/config/meeting-transcription.env}"
  if [[ -e "$config_path" ]]; then
    [[ ! -L "$config_path" ]] || { echo "Meeting config must not be a symlink: $config_path" >&2; exit 1; }
    [[ -f "$config_path" ]] || { echo "Meeting config is not a regular file: $config_path" >&2; exit 1; }

    # The bearer token must not be readable or writable by other local users.
    local mode
    mode="$(stat -f '%Lp' "$config_path")"
    if (( (10#$mode & 077) != 0 )); then
      echo "Refusing insecure meeting config permissions ($mode): chmod 600 $config_path" >&2
      exit 1
    fi

    local line
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      case "$line" in
        ''|'#'*) ;;
        ROWBOAT_MEETING_STT_URL=*) export ROWBOAT_MEETING_STT_URL="${line#*=}" ;;
        ROWBOAT_MEETING_STT_TOKEN=*) export ROWBOAT_MEETING_STT_TOKEN="${line#*=}" ;;
        *)
          echo "Unsupported entry in meeting config; only ROWBOAT_MEETING_STT_URL and ROWBOAT_MEETING_STT_TOKEN are allowed." >&2
          exit 1
          ;;
      esac
    done < "$config_path"
    have_complete_environment || {
      echo "Meeting config must set both ROWBOAT_MEETING_STT_URL and ROWBOAT_MEETING_STT_TOKEN." >&2
      exit 1
    }
    return 0
  fi

  # Today's qualified test token stays in the user Keychain. `security -w`
  # writes the secret only to this shell's command substitution; neither this
  # launcher nor its diagnostics prints it.
  local keychain_token
  if ! keychain_token="$(/usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"; then
    echo "No secure meeting configuration found. Export both ROWBOAT_MEETING_STT_URL and ROWBOAT_MEETING_STT_TOKEN, create an owner-only config file, or add the documented Keychain item." >&2
    exit 1
  fi
  [[ -n "$keychain_token" ]] || { echo "Meeting Keychain item is empty." >&2; exit 1; }
  export ROWBOAT_MEETING_STT_URL="$DEFAULT_STT_URL"
  export ROWBOAT_MEETING_STT_TOKEN="$keychain_token"
}

configure_packaged_aec_environment() {
  [[ "${ROWBOAT_MEETING_AEC_ALPHA:-}" == "1" ]] || return 0
  [[ -f "$AEC_LIBRARY_RESOURCE" && ! -L "$AEC_LIBRARY_RESOURCE" && -x "$AEC_LIBRARY_RESOURCE" ]] || {
    echo "Packaged LocalVQE dylib is missing or unsafe: $AEC_LIBRARY_RESOURCE" >&2
    exit 1
  }
  [[ -f "$AEC_MODEL_RESOURCE" && ! -L "$AEC_MODEL_RESOURCE" ]] || {
    echo "Packaged LocalVQE model is missing or unsafe: $AEC_MODEL_RESOURCE" >&2
    exit 1
  }
  # The helper derives these two fixed adjacent paths from its own executable.
  # Do not export a temporary source path into the child environment.
}

package_app() {
  local forge_bin="$MAIN_DIR/node_modules/.bin/electron-forge"
  [[ -x "$forge_bin" ]] || {
    echo "Rowboat dependencies are missing; run pnpm install from apps/x first." >&2
    exit 1
  }
  # The release pipeline supplies a Developer ID. Contributors without one
  # use Forge's recursive ad-hoc signer, which seals nested helper code before
  # sealing the outer Rowboat.app.
  (
    cd "$MAIN_DIR"
    if [[ -n "${ROWBOAT_LOCAL_SIGNING_IDENTITY:-}" ]]; then
      CI=1 ROWBOAT_MEETING_BRIDGE_ALPHA=1 ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1 \
        ROWBOAT_LOCAL_SIGNING_IDENTITY="$ROWBOAT_LOCAL_SIGNING_IDENTITY" \
        "$forge_bin" package --platform=darwin --arch="$TARGET_ARCH"
    else
      CI=1 ROWBOAT_MEETING_BRIDGE_ALPHA=1 ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1 ROWBOAT_LOCAL_ADHOC_SIGNING=1 \
        "$forge_bin" package --platform=darwin --arch="$TARGET_ARCH"
    fi
  )
  [[ -x "$BRIDGE_EXECUTABLE" ]] || { echo "Packaged meeting bridge is missing: $BRIDGE_EXECUTABLE" >&2; exit 1; }
  if [[ "${ROWBOAT_MEETING_AEC_ALPHA:-}" == "1" ]]; then
    node "$VERIFY_SCRIPT" --app "$APP_BUNDLE" --require-contributor-build --require-localvqe-aec
  else
    node "$VERIFY_SCRIPT" --app "$APP_BUNDLE" --require-contributor-build
  fi
}

package_app

case "$MODE" in
  --package|package|--verify|verify)
    echo "Packaged meeting-capable Rowboat at $APP_BUNDLE"
    ;;
  --stable-install|stable-install)
    if [[ "${ROWBOAT_CONTRIBUTOR_REPLACE:-}" == "1" ]]; then
      node "$CONTRIBUTOR_INSTALL_SCRIPT" --app "$APP_BUNDLE" --replace
    elif [[ -n "${ROWBOAT_CONTRIBUTOR_REPLACE:-}" ]]; then
      echo "ROWBOAT_CONTRIBUTOR_REPLACE must be exactly 1 when replacing an existing contributor build." >&2
      exit 1
    else
      node "$CONTRIBUTOR_INSTALL_SCRIPT" --app "$APP_BUNDLE"
    fi
    ;;
  --debug|debug)
    load_meeting_environment
    export ROWBOAT_MEETING_BRIDGE_ENABLED=1
    export ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1
    export ROWBOAT_MEETING_ONLY=1
    exec lldb -- "$APP_EXECUTABLE"
    ;;
  --telemetry|telemetry)
    load_meeting_environment
    export ROWBOAT_MEETING_BRIDGE_ENABLED=1
    export ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1
    export ROWBOAT_MEETING_ONLY=1
    "$APP_EXECUTABLE" &
    APP_PID=$!
    trap 'kill "$APP_PID" >/dev/null 2>&1 || true' EXIT INT TERM
    /usr/bin/log stream --info --style compact --predicate 'process == "Rowboat"'
    ;;
  --logs|logs)
    load_meeting_environment
    export ROWBOAT_MEETING_BRIDGE_ENABLED=1
    export ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1
    export ROWBOAT_MEETING_ONLY=1
    exec "$APP_EXECUTABLE"
    ;;
  --full|full)
    # Full isolated contributor Rowboat: connectors, Markdown knowledge,
    # graph building, and agents remain enabled. This mode intentionally does
    # not require or enable the experimental meeting bridge; Wispr can own the
    # live meeting while its finalized MCP artifact syncs into Rowboat.
    export ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1
    exec "$APP_EXECUTABLE"
    ;;
  run|--run)
    load_meeting_environment
    export ROWBOAT_MEETING_BRIDGE_ENABLED=1
    export ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1
    export ROWBOAT_MEETING_ONLY=1
    exec "$APP_EXECUTABLE"
    ;;
esac
