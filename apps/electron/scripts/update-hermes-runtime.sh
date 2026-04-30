#!/usr/bin/env bash
# Update the dev/local bundled Hermes runtime for Craft.
#
# SDK-style update: Hermes upstream is treated as a pinned dependency. Click
# "Update Hermes" in the dashboard runs this script, which:
#
#   1. Resolves the new pin (HERMES_VERSION env, or default = "upstream/main").
#   2. Optionally writes that pin into apps/electron/scripts/hermes-version.txt
#      so subsequent rebuilds reproduce the same version.
#   3. Delegates to bundle-hermes.sh, which clones/fetches upstream into a
#      cache directory, applies Craft overlay patches, and rebuilds the vendor
#      runtime.
#
# The user's local fork (if any) is never touched.
#
# Env vars:
#   HERMES_VERSION              Override pin for this run (tag, branch or SHA).
#                               Default: contents of hermes-version.txt.
#   HERMES_PERSIST_PIN=1        Write the resolved pin back into
#                               hermes-version.txt so future rebuilds use it.
#   HERMES_REMOTE_URL           Override upstream git URL.
#
# Packaged apps never reach this script — the RPC handler short-circuits
# updates on app.isPackaged === true.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_SCRIPT="$SCRIPT_DIR/bundle-hermes.sh"
PIN_FILE="$SCRIPT_DIR/hermes-version.txt"

if [ ! -x "$BUNDLE_SCRIPT" ]; then
  chmod +x "$BUNDLE_SCRIPT" 2>/dev/null || true
fi
if [ ! -f "$BUNDLE_SCRIPT" ]; then
  echo "bundle-hermes.sh not found at $BUNDLE_SCRIPT" >&2
  exit 1
fi

# Resolve effective pin for this run. Bundle script reads the same chain, but
# we resolve here so we can log it and (optionally) persist it.
if [ -n "${HERMES_VERSION:-}" ]; then
  RUN_PIN="$HERMES_VERSION"
elif [ -f "$PIN_FILE" ]; then
  RUN_PIN="$(awk 'NF && $1 !~ /^#/ {print; exit}' "$PIN_FILE")"
else
  RUN_PIN="upstream/main"
fi

echo "Hermes update — pin: $RUN_PIN"

if [ "${HERMES_PERSIST_PIN:-0}" = "1" ] && [ -n "${HERMES_VERSION:-}" ]; then
  cat > "$PIN_FILE" <<EOF
# Hermes upstream pin. One line, no quotes. Can be a tag, branch, or commit SHA.
# Bundle/update scripts read this. Click-Update bumps it via HERMES_VERSION env.
$HERMES_VERSION
EOF
  echo "Persisted pin to $PIN_FILE"
fi

# Hand off to bundle. It clones/fetches upstream into the cache and applies
# Craft overlay patches; the user's local fork (if any) is not used.
HERMES_VERSION="$RUN_PIN" bash "$BUNDLE_SCRIPT"

ADAPTER="$ELECTRON_DIR/resources/vendor/hermes/hermes-agent/acp_adapter/server.py"
if [ -f "$ADAPTER" ]; then
  PYTHONPATH="$ELECTRON_DIR/resources/vendor/hermes/hermes-agent" \
    "$ELECTRON_DIR/resources/vendor/hermes/hermes-venv/bin/python3" \
    -c "import acp_adapter.server" \
    && echo "ACP adapter validated: $ADAPTER"
fi

echo "Hermes runtime updated. Restart Craft to use the new bundled runtime."
