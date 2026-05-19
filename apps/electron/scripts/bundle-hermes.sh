#!/usr/bin/env bash
# ==========================================================================
# Hermes Agent — pre-build bundling script (macOS / Linux)
#
# Treats Hermes upstream as a pinned dependency:
#   1. Reads pin from apps/electron/scripts/hermes-version.txt
#      (or `HERMES_VERSION` env var override).
#   2. Maintains a clean clone of `NousResearch/hermes-agent` in a cache dir,
#      checking out the pinned tag/branch/sha.
#   3. Applies Craft overlay patches from apps/electron/scripts/hermes-patches/
#      over that clean clone — never touches a user-managed fork.
#   4. Builds a self-contained runtime under
#      apps/electron/resources/vendor/hermes/ with:
#        - Python (relocatable, via uv)
#        - hermes-venv with Hermes deps installed
#        - hermes-agent source (acp_adapter, agent, tools, hermes_cli, etc.)
#        - External binaries: ripgrep
#
# Usage (from apps/electron):
#   bash scripts/bundle-hermes.sh
#
# Env vars:
#   HERMES_VERSION       upstream tag/branch/SHA to bundle.
#                        Default: contents of hermes-version.txt
#   HERMES_SRC           override clone dir; if set and exists, used as-is.
#                        Otherwise the cache dir is used.
#   HERMES_PYTHON_VER    Python version to bundle (default: 3.13)
#   HERMES_RG_VERSION    ripgrep release version (default: 14.1.1)
#   HERMES_REMOTE_URL    git URL for upstream (default:
#                        https://github.com/NousResearch/hermes-agent.git)
# ==========================================================================

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"

PYTHON_VER="${HERMES_PYTHON_VER:-3.13}"
RG_VERSION="${HERMES_RG_VERSION:-14.1.1}"

VENDOR_DIR="$ELECTRON_DIR/resources/vendor/hermes"
PATCHES_DIR="$SCRIPT_DIR/hermes-patches"
PIN_FILE="$SCRIPT_DIR/hermes-version.txt"
CACHE_DIR="$SCRIPT_DIR/.hermes-cache"
CACHE_SRC="$CACHE_DIR/source"
HERMES_REMOTE_URL="${HERMES_REMOTE_URL:-https://github.com/NousResearch/hermes-agent.git}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin) PLATFORM="darwin" ;;
    Linux)  PLATFORM="linux" ;;
    *)
        echo -e "${RED}✗ Unsupported OS: $OS (use bundle-hermes.ps1 on Windows)${NC}"
        exit 1
        ;;
esac

# --------------------------------------------------------------------------
# Resolve pin (HERMES_VERSION env > hermes-version.txt > "upstream/main" fallback)
# Keep hermes-version.txt pinned to a concrete known-good SHA/tag for normal
# dashboard rebuilds. Floating refs are for explicit bump/overlay-refresh work.
# --------------------------------------------------------------------------

resolve_pin() {
    if [ -n "${HERMES_VERSION:-}" ]; then
        echo "$HERMES_VERSION"
        return
    fi
    if [ -f "$PIN_FILE" ]; then
        # First non-comment, non-blank line.
        awk 'NF && $1 !~ /^#/ {print; exit}' "$PIN_FILE"
        return
    fi
    echo "upstream/main"
}
HERMES_PIN="$(resolve_pin)"

# --------------------------------------------------------------------------
# Resolve source clone (cache by default, HERMES_SRC override allowed)
# --------------------------------------------------------------------------

ensure_cache_clone() {
    mkdir -p "$CACHE_DIR"
    if [ ! -d "$CACHE_SRC/.git" ]; then
        echo -e "${CYAN}→${NC} Cloning Hermes upstream into cache..."
        rm -rf "$CACHE_SRC"
        git clone --filter=blob:none "$HERMES_REMOTE_URL" "$CACHE_SRC"
    fi

    # Refuse to clobber a dirty cache; nuke and re-clone instead. We own this
    # directory — anything in it is throwaway.
    if [ -n "$(git -C "$CACHE_SRC" status --porcelain)" ]; then
        echo -e "${YELLOW}⚠${NC} Cache had local edits — re-cloning fresh"
        rm -rf "$CACHE_SRC"
        git clone --filter=blob:none "$HERMES_REMOTE_URL" "$CACHE_SRC"
    fi

    # Fetch fresh refs so the pin can resolve to a brand-new commit/tag.
    git -C "$CACHE_SRC" fetch --all --tags --prune --quiet

    # Resolve the pin to a concrete ref the cache understands. Try in order:
    # exact ref, origin/<ref>, upstream/<ref> alias for origin, then a remote
    # branch name as-is.
    local ref="$HERMES_PIN"
    case "$ref" in
        upstream/*) ref="origin/${ref#upstream/}" ;;
    esac

    if git -C "$CACHE_SRC" rev-parse --verify "$ref" >/dev/null 2>&1; then
        :
    elif git -C "$CACHE_SRC" rev-parse --verify "origin/$HERMES_PIN" >/dev/null 2>&1; then
        ref="origin/$HERMES_PIN"
    else
        echo -e "${RED}✗ Cannot resolve Hermes pin '$HERMES_PIN' in $CACHE_SRC${NC}"
        exit 1
    fi

    # Detach to the resolved ref so the working tree matches the pin exactly.
    git -C "$CACHE_SRC" -c advice.detachedHead=false checkout --quiet "$ref"
    git -C "$CACHE_SRC" reset --hard --quiet "$ref"

    HERMES_RESOLVED_SHA="$(git -C "$CACHE_SRC" rev-parse --short HEAD)"
}

if [ -n "${HERMES_SRC:-}" ] && [ -d "${HERMES_SRC}" ]; then
    HERMES_RESOLVED_SHA="(override)"
    echo -e "${YELLOW}⚠${NC} Using HERMES_SRC override: $HERMES_SRC (skipping pin/cache/patches)"
    HERMES_USED_SRC="$HERMES_SRC"
    APPLY_PATCHES=0
else
    ensure_cache_clone
    HERMES_USED_SRC="$CACHE_SRC"
    APPLY_PATCHES=1
fi

# --------------------------------------------------------------------------
# Apply Craft overlay patches over the cache clone
# --------------------------------------------------------------------------

if [ "$APPLY_PATCHES" = "1" ] && [ -d "$PATCHES_DIR" ]; then
    shopt -s nullglob
    PATCHES=( "$PATCHES_DIR"/*.patch )
    shopt -u nullglob
    if [ "${#PATCHES[@]}" -gt 0 ]; then
        echo -e "${CYAN}→${NC} Applying ${#PATCHES[@]} Craft overlay patch(es)..."
        for patch in "${PATCHES[@]}"; do
            label="$(basename "$patch")"
            if ! git -C "$HERMES_USED_SRC" apply --check "$patch" 2>/dev/null; then
                echo -e "${RED}✗ Patch failed --check: $label${NC}" >&2
                echo -e "  Pin '$HERMES_PIN' (resolved $HERMES_RESOLVED_SHA) does not match the patch's expected upstream state." >&2
                echo -e "  Refresh the patch against the new upstream and retry." >&2
                exit 1
            fi
            git -C "$HERMES_USED_SRC" apply "$patch"
            echo -e "  ${GREEN}✓${NC} $label"
        done
    fi
fi

echo ""
echo -e "${CYAN}⚕ Hermes Bundle (Craft Agents)${NC}"
echo -e "  Platform: ${PLATFORM}-${ARCH}"
echo -e "  Pin: ${HERMES_PIN} → ${HERMES_RESOLVED_SHA}"
echo -e "  Hermes src: ${HERMES_USED_SRC}"
echo -e "  Output: ${VENDOR_DIR}"
echo ""

# --------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------

if ! command -v uv &>/dev/null; then
    echo -e "${RED}✗ uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh${NC}"
    exit 1
fi

if [ ! -f "$HERMES_USED_SRC/pyproject.toml" ]; then
    echo -e "${RED}✗ pyproject.toml missing at $HERMES_USED_SRC — wrong source dir?${NC}"
    exit 1
fi

# --------------------------------------------------------------------------
# 1. Clean previous bundle
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Cleaning $VENDOR_DIR ..."
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"/{python,hermes-venv,hermes-agent,bin}

# --------------------------------------------------------------------------
# 2. Python via uv
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Installing Python $PYTHON_VER via uv..."
uv python install "$PYTHON_VER"

PYTHON_BIN="$(uv python find "$PYTHON_VER")"
PYTHON_DIR="$(dirname "$(dirname "$PYTHON_BIN")")"
echo -e "${GREEN}✓${NC} Python at: $PYTHON_BIN"

cp -a "$PYTHON_DIR"/. "$VENDOR_DIR/python/"
echo -e "${GREEN}✓${NC} Python copied"

# --------------------------------------------------------------------------
# 3. Create venv from copied Python
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Creating venv..."
"$VENDOR_DIR/python/bin/python3" -m venv "$VENDOR_DIR/hermes-venv"
echo -e "${GREEN}✓${NC} Venv created"

# --------------------------------------------------------------------------
# 4. Install Hermes (non-editable) into venv
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Installing Hermes (non-editable) into venv..."
VENV_PYTHON="$VENDOR_DIR/hermes-venv/bin/python3"

UV_PROJECT_ENVIRONMENT="$VENDOR_DIR/hermes-venv" \
    uv pip install --python "$VENV_PYTHON" "$HERMES_USED_SRC[web,acp,messaging]" 2>&1 | tail -15

UV_PROJECT_ENVIRONMENT="$VENDOR_DIR/hermes-venv" \
    uv pip install --python "$VENV_PYTHON" playwright websockets 2>&1 | tail -15
"$VENV_PYTHON" -m playwright install chromium

if [ -d "$HERMES_USED_SRC/build" ]; then
    rm -rf "$HERMES_USED_SRC/build"
fi
echo -e "${GREEN}✓${NC} Hermes installed with web dashboard, ACP, and Google Meet dependencies"

# --------------------------------------------------------------------------
# 5. Copy Hermes source (subset needed for ACP runtime, with patches applied)
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Copying Hermes source..."

CORE_FILES=(
    run_agent.py model_tools.py toolsets.py cli.py
    hermes_constants.py hermes_state.py hermes_time.py hermes_logging.py
    utils.py mcp_serve.py toolset_distributions.py trajectory_compressor.py
    pyproject.toml
)
for f in "${CORE_FILES[@]}"; do
    [ -f "$HERMES_USED_SRC/$f" ] && cp "$HERMES_USED_SRC/$f" "$VENDOR_DIR/hermes-agent/"
done

CORE_DIRS=(agent tools hermes_cli gateway acp_adapter acp_registry plugins skills)
for d in "${CORE_DIRS[@]}"; do
    [ -d "$HERMES_USED_SRC/$d" ] && cp -a "$HERMES_USED_SRC/$d" "$VENDOR_DIR/hermes-agent/"
done

echo -e "${GREEN}✓${NC} Source copied"

# --------------------------------------------------------------------------
# 6. Build/copy Hermes Web Dashboard assets
# --------------------------------------------------------------------------

WEB_DIST_SRC="$HERMES_USED_SRC/hermes_cli/web_dist"
WEB_DIR="$HERMES_USED_SRC/web"
WEB_DIST_DEST="$VENDOR_DIR/hermes-agent/hermes_cli/web_dist"

if [ -d "$WEB_DIST_SRC" ] && [ -f "$WEB_DIST_SRC/index.html" ]; then
    echo -e "${CYAN}→${NC} Copying existing Hermes web dashboard assets..."
    rm -rf "$WEB_DIST_DEST"
    mkdir -p "$(dirname "$WEB_DIST_DEST")"
    cp -a "$WEB_DIST_SRC" "$WEB_DIST_DEST"
    echo -e "${GREEN}✓${NC} Web dashboard assets copied"
elif [ -f "$WEB_DIR/package.json" ] && command -v npm &>/dev/null; then
    echo -e "${CYAN}→${NC} Building Hermes web dashboard assets..."
    if [ -f "$WEB_DIR/package-lock.json" ]; then
        (cd "$WEB_DIR" && npm ci --silent && npm run build)
    else
        (cd "$WEB_DIR" && npm install --silent && npm run build)
    fi
    if [ -d "$WEB_DIST_SRC" ] && [ -f "$WEB_DIST_SRC/index.html" ]; then
        rm -rf "$WEB_DIST_DEST"
        mkdir -p "$(dirname "$WEB_DIST_DEST")"
        cp -a "$WEB_DIST_SRC" "$WEB_DIST_DEST"
        echo -e "${GREEN}✓${NC} Web dashboard assets built and copied"
    else
        echo -e "${YELLOW}⚠${NC} Hermes web build finished but web_dist was not found"
    fi
else
    echo -e "${YELLOW}⚠${NC} Hermes web dashboard assets unavailable (no hermes_cli/web_dist and npm/web source missing)"
fi

# --------------------------------------------------------------------------
# 7. ripgrep binary
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Downloading ripgrep ${RG_VERSION}..."
case "${PLATFORM}-${ARCH}" in
    darwin-arm64) RG_TARGET="aarch64-apple-darwin" ;;
    darwin-x86_64) RG_TARGET="x86_64-apple-darwin" ;;
    linux-x86_64)  RG_TARGET="x86_64-unknown-linux-musl" ;;
    linux-aarch64) RG_TARGET="aarch64-unknown-linux-gnu" ;;
    *)
        echo -e "${YELLOW}⚠${NC} Unsupported arch ${PLATFORM}-${ARCH} for ripgrep download — skipping"
        RG_TARGET=""
        ;;
esac

if [ -n "$RG_TARGET" ]; then
    RG_URL="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${RG_TARGET}.tar.gz"
    TMP_RG="$(mktemp -d)"
    curl -fsSL "$RG_URL" | tar xz -C "$TMP_RG"
    cp "$TMP_RG/ripgrep-${RG_VERSION}-${RG_TARGET}/rg" "$VENDOR_DIR/bin/rg"
    chmod +x "$VENDOR_DIR/bin/rg"
    rm -rf "$TMP_RG"
    echo -e "${GREEN}✓${NC} ripgrep installed"
fi

# --------------------------------------------------------------------------
# 8. Strip unused files
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Stripping unused files..."

find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -name "*.pyc" -delete 2>/dev/null || true
find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -name "*.a" -delete 2>/dev/null || true
find "$VENDOR_DIR/hermes-venv/lib" -type d \( -name "tests" -o -name "test" -o -name "testing" \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$VENDOR_DIR/python/lib/python"*/test 2>/dev/null || true

while IFS= read -r -d '' d; do
    if [ ! -f "$d/Contents/Info.plist" ]; then
        mv "$d" "${d%.app}.app-dir"
    fi
done < <(find "$VENDOR_DIR" -type d -name "*.app" -print0 2>/dev/null)

BROKEN=0
while IFS= read -r -d '' link; do
    rm -f "$link"
    BROKEN=$((BROKEN + 1))
done < <(find "$VENDOR_DIR" -type l ! -exec test -e {} \; -print0 2>/dev/null)
[ "$BROKEN" -gt 0 ] && echo -e "${YELLOW}⚠${NC} Removed $BROKEN broken symlinks"

# --------------------------------------------------------------------------
# 9. Patch venv for relocatability
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Patching venv for relocatable paths..."

PYVENV_CFG="$VENDOR_DIR/hermes-venv/pyvenv.cfg"
if [ -f "$PYVENV_CFG" ]; then
    if [ "$PLATFORM" = "darwin" ]; then
        sed -i '' "s|home = .*|home = ../python/bin|" "$PYVENV_CFG" || true
    else
        sed -i "s|home = .*|home = ../python/bin|" "$PYVENV_CFG" || true
    fi
fi

VENV_BIN="$VENDOR_DIR/hermes-venv/bin"
for link in "$VENV_BIN/python3" "$VENV_BIN/python" "$VENV_BIN/python$PYTHON_VER"; do
    [ -L "$link" ] && rm -f "$link"
done
ln -s "../../python/bin/python3" "$VENV_BIN/python3"
ln -s "python3" "$VENV_BIN/python"
ln -s "python3" "$VENV_BIN/python$PYTHON_VER"

for script in "$VENV_BIN"/*; do
    if [ -f "$script" ] && head -1 "$script" 2>/dev/null | grep -q "^#!.*python"; then
        if [ "$PLATFORM" = "darwin" ]; then
            sed -i '' "1s|^#!.*|#!/usr/bin/env python3|" "$script" || true
        else
            sed -i "1s|^#!.*|#!/usr/bin/env python3|" "$script" || true
        fi
    fi
done

FINAL_BROKEN=0
while IFS= read -r -d '' link; do
    rm -f "$link"
    FINAL_BROKEN=$((FINAL_BROKEN + 1))
done < <(find "$VENDOR_DIR" -type l ! -exec test -e {} \; -print0 2>/dev/null)
[ "$FINAL_BROKEN" -gt 0 ] && echo -e "${YELLOW}⚠${NC} Removed $FINAL_BROKEN broken symlinks (post-patch)"

echo -e "${GREEN}✓${NC} Venv patched"

# --------------------------------------------------------------------------
# 10. Smoke test
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Smoke test..."
"$VENV_BIN/python3" -c "import sys; print(f'  Python {sys.version.split()[0]} OK')"
PYTHONPATH="$VENDOR_DIR/hermes-agent" \
    "$VENV_BIN/python3" -c "import acp_adapter; import acp_adapter.server; print('  acp_adapter import OK')" || {
    echo -e "${YELLOW}⚠${NC} acp_adapter not importable from venv — check pyproject install"
}

# --------------------------------------------------------------------------
# 11. Summary
# --------------------------------------------------------------------------

echo ""
echo -e "${GREEN}✓ Hermes bundle built${NC}"
echo "  Pin: $HERMES_PIN ($HERMES_RESOLVED_SHA)"
du -sh "$VENDOR_DIR"/* 2>/dev/null | sort -rh
echo ""
echo "Total: $(du -sh "$VENDOR_DIR" 2>/dev/null | cut -f1)"
echo ""
