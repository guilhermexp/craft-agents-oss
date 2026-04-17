#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-arm64}"

if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
    echo "Usage: release-mac.sh [arm64|x64]"
    echo "Default: arm64 (Apple Silicon)"
    exit 1
fi

# electron-builder / @electron/rebuild invoke a bare "python" binary. macOS
# ships only python3, so provide a shim pointing at python3 when absent.
if ! command -v python >/dev/null 2>&1; then
    PY3="$(command -v python3 || true)"
    if [ -z "$PY3" ]; then
        echo "ERROR: python3 not found in PATH. Install Python 3 first."
        exit 1
    fi
    SHIM_DIR="$ROOT_DIR/.build/pyshim"
    mkdir -p "$SHIM_DIR"
    ln -sf "$PY3" "$SHIM_DIR/python"
    export PATH="$SHIM_DIR:$PATH"
    echo "Using python shim: $SHIM_DIR/python -> $PY3"
fi

cd "$ROOT_DIR/apps/electron"
if [ "$ARCH" = "x64" ]; then
    bun run dist:mac:x64
else
    bun run dist:mac
fi

RELEASE_DIR="$ROOT_DIR/apps/electron/release"
DMG="$RELEASE_DIR/Craft-Agents-${ARCH}.dmg"

if [ ! -f "$DMG" ]; then
    echo "ERROR: DMG not found at $DMG"
    exit 1
fi

# Keep only the requested-arch DMG. electron-builder emits zips, blockmaps,
# unpackaged app dirs (mac/, mac-arm64/), builder-debug.yml and latest-mac.yml
# on every build — all noise for a local release artifact.
echo ""
echo "Cleaning build artifacts..."
find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 ! -name "Craft-Agents-${ARCH}.dmg" -exec rm -rf {} +

echo ""
echo "=== DMG ready ==="
echo "Path: $DMG"
echo "Size: $(du -h "$DMG" | cut -f1)"
echo "SHA:  $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
