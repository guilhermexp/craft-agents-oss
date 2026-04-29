#!/usr/bin/env bash
# ==========================================================================
# Hermes Agent — pre-build bundling script (macOS / Linux)
#
# Builds a self-contained Hermes runtime under
# apps/electron/resources/vendor/hermes/ with:
#   - Python (relocatable, via uv)
#   - hermes-venv with Hermes deps installed
#   - hermes-agent source (acp_adapter, agent, tools, hermes_cli, etc.)
#   - External binaries: ripgrep
#
# Replicates the pattern in atomic-hermes/desktop/scripts/bundle-all.sh.
#
# Usage (from apps/electron):
#   bash scripts/bundle-hermes.sh
#
# Env vars:
#   HERMES_SRC          path to Hermes source clone
#                       (default: ../../../hermes-agent relative to this script)
#   HERMES_PYTHON_VER   Python version to bundle (default: 3.13)
#   HERMES_RG_VERSION   ripgrep release version (default: 14.1.1)
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

HERMES_SRC="${HERMES_SRC:-$REPO_ROOT/../hermes-agent}"
PYTHON_VER="${HERMES_PYTHON_VER:-3.13}"
RG_VERSION="${HERMES_RG_VERSION:-14.1.1}"

VENDOR_DIR="$ELECTRON_DIR/resources/vendor/hermes"

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

echo ""
echo -e "${CYAN}⚕ Hermes Bundle (Craft Agents)${NC}"
echo -e "  Platform: ${PLATFORM}-${ARCH}"
echo -e "  Hermes src: ${HERMES_SRC}"
echo -e "  Output: ${VENDOR_DIR}"
echo ""

# --------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------

if ! command -v uv &>/dev/null; then
    echo -e "${RED}✗ uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh${NC}"
    exit 1
fi

if [ ! -d "$HERMES_SRC" ]; then
    echo -e "${RED}✗ Hermes source not found at: $HERMES_SRC${NC}"
    echo -e "  Set HERMES_SRC env var or clone:"
    echo -e "    git clone https://github.com/NousResearch/hermes-agent.git $HERMES_SRC"
    exit 1
fi

if [ ! -f "$HERMES_SRC/pyproject.toml" ]; then
    echo -e "${RED}✗ pyproject.toml missing at $HERMES_SRC — wrong source dir?${NC}"
    exit 1
fi

# --------------------------------------------------------------------------
# 1. Clean previous bundle
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Cleaning $VENDOR_DIR ..."
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"/{python,hermes-venv,hermes-agent,bin}

# --------------------------------------------------------------------------
# 2. Python via uv (downloads python-build-standalone)
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
#
# Non-editable install copies the source into site-packages, making the venv
# fully relocatable. Editable installs leave behind an .egg-link with the
# absolute build-time path, which breaks once the user moves the app.

echo -e "${CYAN}→${NC} Installing Hermes (non-editable) into venv..."
VENV_PYTHON="$VENDOR_DIR/hermes-venv/bin/python3"

UV_PROJECT_ENVIRONMENT="$VENDOR_DIR/hermes-venv" \
    uv pip install --python "$VENV_PYTHON" "$HERMES_SRC" 2>&1 | tail -15
echo -e "${GREEN}✓${NC} Hermes installed"

# --------------------------------------------------------------------------
# 5. Copy Hermes source (subset needed for ACP runtime)
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Copying Hermes source..."

CORE_FILES=(
    run_agent.py model_tools.py toolsets.py cli.py
    hermes_constants.py hermes_state.py hermes_time.py hermes_logging.py
    utils.py mcp_serve.py toolset_distributions.py trajectory_compressor.py
    pyproject.toml
)
for f in "${CORE_FILES[@]}"; do
    [ -f "$HERMES_SRC/$f" ] && cp "$HERMES_SRC/$f" "$VENDOR_DIR/hermes-agent/"
done

CORE_DIRS=(agent tools hermes_cli gateway acp_adapter acp_registry plugins skills)
for d in "${CORE_DIRS[@]}"; do
    [ -d "$HERMES_SRC/$d" ] && cp -a "$HERMES_SRC/$d" "$VENDOR_DIR/hermes-agent/"
done

echo -e "${GREEN}✓${NC} Source copied"

# --------------------------------------------------------------------------
# 5b. Patch ACP adapter for Craft streaming
# --------------------------------------------------------------------------

ACP_SERVER="$VENDOR_DIR/hermes-agent/acp_adapter/server.py"
if [ -f "$ACP_SERVER" ]; then
    echo -e "${CYAN}→${NC} Patching Hermes ACP adapter streaming..."
    python3 - "$ACP_SERVER" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

old_callbacks = """        agent = state.agent
        agent.tool_progress_callback = tool_progress_cb
        agent.thinking_callback = thinking_cb
        agent.step_callback = step_cb
        agent.message_callback = message_cb

        if approval_cb:
"""
new_callbacks = """        agent = state.agent
        agent.tool_progress_callback = tool_progress_cb
        # Hermes' AIAgent streams visible assistant text through
        # run_conversation(stream_callback=...).  The older `message_callback`
        # attribute is not read by run_agent.py, so setting only that makes ACP
        # turns finish with no assistant message.
        agent.reasoning_callback = thinking_cb
        agent.thinking_callback = thinking_cb
        agent.step_callback = step_cb

        streamed_text_parts: list[str] = []
        if message_cb:
            raw_message_cb = message_cb

            def tracked_message_cb(text: str) -> None:
                if isinstance(text, str) and text:
                    streamed_text_parts.append(text)
                raw_message_cb(text)

            message_cb = tracked_message_cb

        if approval_cb:
"""
old_run = """                result = agent.run_conversation(
                    user_message=user_text,
                    conversation_history=state.history,
                    task_id=session_id,
                )
"""
new_run = """                result = agent.run_conversation(
                    user_message=user_text,
                    conversation_history=state.history,
                    task_id=session_id,
                    stream_callback=message_cb,
                )
"""
old_final = """        final_response = result.get("final_response", "")
        if final_response and conn:
            update = acp.update_agent_message_text(final_response)
            await conn.session_update(session_id, update)
"""
new_final = """        final_response = result.get("final_response", "")
        if final_response and conn and not streamed_text_parts:
            update = acp.update_agent_message_text(final_response)
            await conn.session_update(session_id, update)
"""

for old, new in ((old_callbacks, new_callbacks), (old_run, new_run), (old_final, new_final)):
    if old in text:
        text = text.replace(old, new, 1)
    elif new not in text:
        raise SystemExit(f"Expected ACP adapter patch target not found in {path}")

path.write_text(text)
PY
    echo -e "${GREEN}✓${NC} ACP adapter patched"
fi

# --------------------------------------------------------------------------
# 6. Build/copy Hermes Web Dashboard assets
# --------------------------------------------------------------------------

WEB_DIST_SRC="$HERMES_SRC/hermes_cli/web_dist"
WEB_DIR="$HERMES_SRC/web"
WEB_DIST_DEST="$VENDOR_DIR/hermes-agent/hermes_cli/web_dist"

if [ -d "$WEB_DIST_SRC" ] && [ -f "$WEB_DIST_SRC/index.html" ]; then
    echo -e "${CYAN}→${NC} Copying existing Hermes web dashboard assets..."
    rm -rf "$WEB_DIST_DEST"
    mkdir -p "$(dirname "$WEB_DIST_DEST")"
    cp -a "$WEB_DIST_SRC" "$WEB_DIST_DEST"
    echo -e "${GREEN}✓${NC} Web dashboard assets copied"
elif [ -f "$WEB_DIR/package.json" ] && command -v npm &>/dev/null; then
    echo -e "${CYAN}→${NC} Building Hermes web dashboard assets..."
    (cd "$WEB_DIR" && npm install --silent && npm run build)
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
# 8. Strip unused files (smaller bundle, faster codesign)
# --------------------------------------------------------------------------

echo -e "${CYAN}→${NC} Stripping unused files..."

find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -name "*.pyc" -delete 2>/dev/null || true
find "$VENDOR_DIR/python" "$VENDOR_DIR/hermes-venv" -name "*.a" -delete 2>/dev/null || true
find "$VENDOR_DIR/hermes-venv/lib" -type d \( -name "tests" -o -name "test" -o -name "testing" \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$VENDOR_DIR/python/lib/python"*/test 2>/dev/null || true

# Rename fake .app dirs (codesign rejects them)
while IFS= read -r -d '' d; do
    if [ ! -f "$d/Contents/Info.plist" ]; then
        mv "$d" "${d%.app}.app-dir"
    fi
done < <(find "$VENDOR_DIR" -type d -name "*.app" -print0 2>/dev/null)

# Remove broken symlinks (codesign --verify --deep --strict rejects them)
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

# Replace absolute symlinks in venv/bin with relative ones
VENV_BIN="$VENDOR_DIR/hermes-venv/bin"
for link in "$VENV_BIN/python3" "$VENV_BIN/python" "$VENV_BIN/python$PYTHON_VER"; do
    [ -L "$link" ] && rm -f "$link"
done
ln -s "../../python/bin/python3" "$VENV_BIN/python3"
ln -s "python3" "$VENV_BIN/python"
ln -s "python3" "$VENV_BIN/python$PYTHON_VER"

# Patch shebangs in venv scripts to use env python3
for script in "$VENV_BIN"/*; do
    if [ -f "$script" ] && head -1 "$script" 2>/dev/null | grep -q "^#!.*python"; then
        if [ "$PLATFORM" = "darwin" ]; then
            sed -i '' "1s|^#!.*|#!/usr/bin/env python3|" "$script" || true
        else
            sed -i "1s|^#!.*|#!/usr/bin/env python3|" "$script" || true
        fi
    fi
done

# Final pass: kill any new broken symlinks
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
"$VENV_BIN/python3" -c "import acp_adapter; print('  acp_adapter import OK')" || {
    echo -e "${YELLOW}⚠${NC} acp_adapter not importable from venv — check pyproject install"
}

# --------------------------------------------------------------------------
# 11. Summary
# --------------------------------------------------------------------------

echo ""
echo -e "${GREEN}✓ Hermes bundle built${NC}"
du -sh "$VENDOR_DIR"/* 2>/dev/null | sort -rh
echo ""
echo "Total: $(du -sh "$VENDOR_DIR" 2>/dev/null | cut -f1)"
echo ""
