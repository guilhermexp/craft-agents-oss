#!/usr/bin/env bash
# Update the dev/local bundled Hermes runtime for Craft.
# This is intentionally disabled for packaged apps by the RPC handler.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"

DEFAULT_HERMES_SRC="$REPO_ROOT/../hermes-agent"
if [ ! -d "$DEFAULT_HERMES_SRC" ] && [ -d "$ELECTRON_DIR/../../../hermes-agent" ]; then
  DEFAULT_HERMES_SRC="$(cd "$ELECTRON_DIR/../../../hermes-agent" && pwd)"
fi
HERMES_SRC="${HERMES_SRC:-${HERMES_SOURCE_DIR:-$DEFAULT_HERMES_SRC}}"
BUNDLE_SCRIPT="$SCRIPT_DIR/bundle-hermes.sh"

if [ ! -x "$BUNDLE_SCRIPT" ]; then
  chmod +x "$BUNDLE_SCRIPT" 2>/dev/null || true
fi

if [ ! -f "$BUNDLE_SCRIPT" ]; then
  echo "bundle-hermes.sh not found at $BUNDLE_SCRIPT" >&2
  exit 1
fi

if [ ! -d "$HERMES_SRC" ]; then
  echo "Hermes source not found at $HERMES_SRC" >&2
  echo "Set HERMES_SRC=/path/to/hermes-agent and retry." >&2
  exit 1
fi

if [ ! -f "$HERMES_SRC/pyproject.toml" ]; then
  echo "pyproject.toml missing in Hermes source: $HERMES_SRC" >&2
  exit 1
fi

echo "Hermes source: $HERMES_SRC"
if git -C "$HERMES_SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  before="$(git -C "$HERMES_SRC" rev-parse --short HEAD)"
  echo "Hermes commit before: $before"
  if [ "${HERMES_SKIP_PULL:-0}" != "1" ]; then
    if [ -n "$(git -C "$HERMES_SRC" status --porcelain)" ]; then
      echo "Hermes source has uncommitted changes. Commit/stash them or set HERMES_SKIP_PULL=1." >&2
      exit 1
    fi

    HERMES_UPDATE_REMOTE="${HERMES_UPDATE_REMOTE:-${HERMES_UPSTREAM_REMOTE:-upstream}}"
    HERMES_UPDATE_BRANCH="${HERMES_UPDATE_BRANCH:-${HERMES_UPSTREAM_BRANCH:-main}}"
    if ! git -C "$HERMES_SRC" remote get-url "$HERMES_UPDATE_REMOTE" >/dev/null 2>&1; then
      HERMES_UPDATE_REMOTE="origin"
    fi

    echo "Fetching Hermes updates from $HERMES_UPDATE_REMOTE/$HERMES_UPDATE_BRANCH"
    git -C "$HERMES_SRC" fetch "$HERMES_UPDATE_REMOTE" "$HERMES_UPDATE_BRANCH"
    git -C "$HERMES_SRC" merge --ff-only FETCH_HEAD
  else
    echo "Skipping git pull because HERMES_SKIP_PULL=1"
  fi
  after="$(git -C "$HERMES_SRC" rev-parse --short HEAD)"
  echo "Hermes commit after: $after"
else
  echo "Hermes source is not a git checkout; bundling current files."
fi

HERMES_SRC="$HERMES_SRC" bash "$BUNDLE_SCRIPT"

ADAPTER="$ELECTRON_DIR/resources/vendor/hermes/hermes-agent/acp_adapter/server.py"
if [ -f "$ADAPTER" ]; then
  "$ELECTRON_DIR/resources/vendor/hermes/hermes-venv/bin/python3" -m py_compile "$ADAPTER"
  echo "ACP adapter validated: $ADAPTER"
fi

echo "Hermes runtime updated. Restart Craft to use the new bundled runtime."
