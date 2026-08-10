#!/bin/bash
# Lint guard: detect raw webContents.send() outside typed wrappers.
#
# Approved locations:
#   - window-manager.ts:  broadcastToAll / broadcastToAllExcept / broadcastToWorkspace / sendToWindow
#   - browser-pane-manager.ts:  toolbar scope (separate preload context, not in BroadcastEventMap)
#   - browser/theme-extractor.ts:  toolbar scope (TOOLBAR_CHANNELS on the toolbar BrowserView)
#   - browser/toolbar-host.ts:  toolbar scope (TOOLBAR_CHANNELS on the toolbar BrowserView)
#   - menu.ts:  sendToRenderer (typed with MenuBroadcastChannel)
#
# All other raw webContents.send() calls should use typed WindowManager methods.

set -euo pipefail

if command -v rg >/dev/null 2>&1; then
  VIOLATIONS=$(rg 'webContents\.send\(' apps/electron/src/main/ \
    --glob '!**/window-manager.ts' \
    --glob '!**/browser-pane-manager.ts' \
    --glob '!**/browser/theme-extractor.ts' \
    --glob '!**/browser/toolbar-host.ts' \
    --glob '!**/menu.ts' \
    -l 2>/dev/null || true)
else
  VIOLATIONS=$(grep -R -l -E 'webContents\.send\(' apps/electron/src/main/ \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude='window-manager.ts' \
    --exclude='browser-pane-manager.ts' \
    --exclude='theme-extractor.ts' \
    --exclude='toolbar-host.ts' \
    --exclude='menu.ts' 2>/dev/null || true)
fi

if [ -n "${VIOLATIONS:-}" ]; then
  echo "ERROR: Raw webContents.send() found outside approved wrappers:"
  echo "$VIOLATIONS"
  echo ""
  echo "Use windowManager.broadcastToAll/broadcastToAllExcept/broadcastToWorkspace/sendToWindow instead."
  echo "See apps/electron/src/main/window-manager.ts for typed broadcast methods."
  exit 1
fi

echo "OK: No raw webContents.send() outside approved wrappers."
