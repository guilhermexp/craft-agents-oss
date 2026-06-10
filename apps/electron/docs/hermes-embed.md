# Hermes Agent — Embedded Runtime

Craft Agents bundles the Hermes Python agent inside the Electron app. The
runtime ships as `extraResources`, runs as an ACP stdio subprocess, and does
not require the user to install `hermes` separately.

Reference implementation: [`atomic-hermes/desktop`](https://github.com/AtomicBot-ai/atomic-hermes).
Hermes upstream: [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).

## Current contract

Hermes inside Craft is treated as a **pinned upstream dependency** (SDK model),
not as a hand-maintained fork:

- Pin source of truth: `apps/electron/scripts/hermes-version.txt` — first
  non-comment, non-blank line is any git ref upstream understands (tag,
  branch, SHA). Daily/dashboard updates should use a concrete tag or SHA so
  the Craft overlay patches target a reproducible upstream state.
- Upstream URL: `https://github.com/NousResearch/hermes-agent.git`. Do not
  point the normal flow at `guilhermexp/hermes-agent` or any user fork.
- Source clone lives in a Craft-owned cache:
  `apps/electron/scripts/.hermes-cache/source` (gitignored). The bundle script
  clones/fetches/checks out the pin there. **Any user fork at
  `../hermes-agent` is ignored by the build path.**
- Craft-side modifications live as overlay patches under
  `apps/electron/scripts/hermes-patches/*.patch`, applied to the pristine
  cache clone before bundling.
- The embedded runtime under `apps/electron/resources/vendor/hermes/` is a
  generated bundle, fully reproducible from `(pin + patches)`.

In local development, avoid leaving the pin on floating refs such as
`upstream/main` for day-to-day dashboard usage: upstream can move underneath
Craft's overlay patches and make **Update Hermes** fail. A Hermes upgrade is
therefore either:

- the normal reproducible path: keep `hermes-version.txt` pinned to a known-good
  tag/SHA and click Update to rebuild exactly that `(pin + patches)` pair; or
- an explicit bump path: temporarily set `HERMES_VERSION=<new-tag-or-sha>` or
  `upstream/main`, refresh overlays if needed, validate, then persist the
  resolved known-good tag/SHA back into `hermes-version.txt`.

There is no hand-merging into a fork, and no other Craft agent backend shares
Hermes' Python runtime, config, sessions, or tool registry.

Claude e Pi agora pertencem a fronteira do runtime nativo de agentes em
`packages/shared/src/agent/native/`. Hermes fica explicitamente fora desse
runtime: codigo nativo nao deve registrar driver Hermes, resolver paths do
dashboard, normalizar config Hermes ou tocar `HERMES_HOME`. Sessoes Hermes
entram por `HermesAgent`, `acp-config.ts`, auth bridge Hermes e ACP
`session.mcpServers`.

## Pinning and updating

| Action | Command |
| ------ | ------- |
| Rebuild the known-good pinned Hermes | Click "Update Hermes" in dashboard, or `bash apps/electron/scripts/update-hermes-runtime.sh` |
| Explicitly test/bump to current `upstream/main` | `HERMES_VERSION=upstream/main bash apps/electron/scripts/update-hermes-runtime.sh`, refresh overlays if needed, then persist the resolved known-good SHA |
| Pin to a specific tag and persist it | `HERMES_VERSION=v2026.4.23 HERMES_PERSIST_PIN=1 bash apps/electron/scripts/update-hermes-runtime.sh` |
| One-off rebuild against a specific SHA without persisting | `HERMES_VERSION=<sha> bash apps/electron/scripts/update-hermes-runtime.sh` |
| Force a clean cache | `rm -rf apps/electron/scripts/.hermes-cache && bash apps/electron/scripts/update-hermes-runtime.sh` |
| Pin rollback | Edit `apps/electron/scripts/hermes-version.txt` to the previous tag/SHA, rerun update |

The dashboard's "Update Hermes" button is wired to `update-hermes-runtime.sh`
through `CRAFT_HERMES_UPDATE_COMMAND_JSON`; click → cache fetch+checkout →
patch overlay → venv install → vendor copy → smoke test. The user's local
filesystem outside Craft (any standalone `hermes`, `~/.hermes`, sibling
`hermes-agent` checkout) is not consulted.

### Overlay patches

Files under `apps/electron/scripts/hermes-patches/`:

| Patch | Purpose |
| ----- | ------- |
| `01-acp-server.patch` | ACP adapter `acp_adapter/server.py` + `session.py` — stores ACP-provided `mcp_servers` on session state, wires a single streaming path (`stream_callback`) so Hermes streams text live to Craft without duplicate deltas across profile-local sessions, and reapplies ACP MCP toolsets after `/model` or ACP `session/set_model` recreates the underlying `AIAgent`. Upstream Hermes now owns reasoning-delta routing, so do not reintroduce duplicate `reasoning_callback` patches unless upstream removes it. |
| `02-mcp-tool-craft-naming.patch` | `tools/mcp_tool.py` — keep `craft-session` and `craft-sources` MCP servers under Craft canonical tool names (`mcp__session__…`, `mcp__github__…`); other MCP servers stay on Hermes-normal names. |
| `03-web-server-craft-embedded.patch` | `hermes_cli/web_server.py` — `_craft_embedded_update_command()` so the Hermes dashboard's Update button delegates to Craft's update script when running embedded inside Craft, rather than running the standalone Hermes installer. |
| `05-google-meet-localized-join.patch` | `plugins/google_meet/meet_bot.py` — extends the join-button matcher with localized labels (`Participar agora`, `Entrar agora`, `Unirse ahora`, `Pedir para participar`, …) so the bot joins meetings whose UI is not in English. |
| `06-google-meet-debug-and-robust-click.patch` | `plugins/google_meet/meet_bot.py` — adds structured launch/auth logging plus per-step page screenshots and falls back to Playwright role-based clicks when text matching misses, so toolbar invitations can surface why a join failed instead of timing out silently. |

When a patch fails `git apply --check`, upstream changed the patched code. Keep
daily dashboard usage on the previous known-good SHA; only move to the new
upstream after refreshing the affected overlay patch against the new cache head:

```bash
# After update-hermes-runtime.sh failed with "Patch failed --check: NN-name.patch":
HERMES_PIN_DIR=apps/electron/scripts/.hermes-cache/source

# 1. Start from the pristine upstream commit that the update resolved.
git -C "$HERMES_PIN_DIR" reset --hard HEAD

# 2. Inspect the new upstream code and hand-apply the intended Craft behavior.
#    Keep the patch minimal: only Craft's bridge/embedding delta belongs here.

# 3. Capture the new diff back into the matching patch file.
git -C "$HERMES_PIN_DIR" diff -- <files…> \
  > apps/electron/scripts/hermes-patches/NN-name.patch

# 4. Prove every overlay still applies to a clean cache checkout.
git -C "$HERMES_PIN_DIR" reset --hard HEAD
for p in apps/electron/scripts/hermes-patches/*.patch; do
  git -C "$HERMES_PIN_DIR" apply --check "$PWD/$p"
done
```

Commit the refreshed patch to Craft together with the new known-good pin if the
Hermes bump should become the day-to-day dashboard target.

### Explicit source override

The normal Craft flow does not use a user fork. Treat
`guilhermexp/hermes-agent` and sibling `../hermes-agent` checkouts as
out-of-band: they are not consulted by dashboard Update, `bundle-hermes.*`, or
release packaging.

`HERMES_SRC=/path/to/hermes-agent` remains an explicit, short-lived development
override for active Hermes source work only. When set, the bundle script uses
that checkout as-is and skips the cache + patch step. Unset it before validating
Craft's embedded update path. Production and daily local updates run through
`NousResearch/hermes-agent` + `hermes-version.txt` + Craft overlay patches.

When syncing Craft upstream, preserve these Craft-side integration points:

| Craft file | Craft-required behavior |
| ---------- | ----------------------- |
| `packages/shared/src/agent/hermes-agent.ts` | Hermes gets both `craft-sources` and `craft-session` MCP endpoints through ACP; source changes do not kill an active stream; model/session changes do not silently drop MCP config. Normal Hermes turns are prefixed with a hidden Craft session context envelope containing workspace, session labels, matching War Room channel metadata, and privacy rules so a session opened under `#client` starts with the right client/project context even outside the War Room orchestrator path. Before each subprocess spawn, calls `seedHermesAuthFromCraft` so embedded Hermes inherits the user's already-authenticated Craft OAuth/API-key credentials. ACP permission requests from Hermes are bridged into Craft's native `permission_request` event so the renderer shows the same approval UI and desktop notification used by Claude/Pi. |
| `packages/shared/src/hermes/acp-config.ts` | Bundled runtime env (`CRAFT_HERMES_PYTHON`, `CRAFT_HERMES_ARGS`, `CRAFT_HERMES_HOME`) is treated as one coherent ACP command/config unit. In packaged builds, `CRAFT_HERMES_REQUIRE_BUNDLED=1` must fail closed instead of falling back to a system `hermes`. |
| `packages/shared/src/hermes/auth-bridge.ts` | One-way seed (Craft → Hermes) at spawn: Craft Credential Manager / LLM connections are the source of truth. Claude OAuth → `CLAUDE_CODE_OAUTH_TOKEN`; ChatGPT Plus/Codex OAuth → `<HERMES_HOME>/auth.json` `providers["openai-codex"].tokens`; API-key connections → provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `XAI_API_KEY`, etc.) for the Hermes subprocess/dashboard. No separate Hermes `.env` secret store is required for the embedded app. |
| `packages/shared/src/mcp/session-tools-server.ts` | Craft-native tools exposed to Hermes include browser, delegation/session, LLM, auth/config helpers, metadata, and automation; callbacks stay session-scoped. |
| `packages/server-core/src/handlers/rpc/hermes.ts` | Runtime detection, dashboard process launch, file/log/skill browsing, dashboard-delegated dev update env, update marker watching, and restart notification stay local-only and path-safe under app-scoped `HERMES_HOME`. Also watches `<HERMES_HOME>/auth.json` so that when Hermes refreshes a Codex (`openai-codex`) OAuth token the new tokens are written back into Craft's credential store via `setLlmOAuth('chatgpt-plus', …)`. In Electron GUI mode, `hermes:startDashboard` delegates the visual mount to `hermes-dashboard-host`. |
| `apps/electron/src/main/hermes-dashboard-host/` | Owns the Electron visual host for the Hermes dashboard: creates/reuses/closes the dedicated BrowserPane instance, validates the active localhost dashboard origin, keeps navigation policy scoped to that origin plus supported Craft deep-links, and refuses query-string auth handoff. It does not start ACP sessions, own `HERMES_HOME`, or persist secrets. |
| `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx` | Settings remains an operational Hermes page with compact files/skills views, version line, dashboard launch delegated through `hermes:startDashboard`, and no giant raw session dump. It must not duplicate the dashboard's native update action or create BrowserPane instances directly for Hermes. |
| `apps/electron/scripts/bundle-hermes.*` and `update-hermes-runtime.*` | Bundling installs Hermes with `[web,acp]` from the pin in `hermes-version.txt`, applies overlay patches from `hermes-patches/`, mirrors required source files, validates ACP, and updates only in dev. Packaged builds short-circuit `update-hermes-runtime.*` in the RPC handler. |
| `apps/electron/scripts/hermes-version.txt` | Single source of truth for the upstream pin. Bumped via `HERMES_VERSION=… HERMES_PERSIST_PIN=1` or by editing the file. |
| `apps/electron/scripts/hermes-patches/*.patch` | Craft-side overlay applied on the pristine cache clone before bundling. Refresh against new pins when `git apply --check` fails. |

The intended runtime model is:

- Hermes is a separate Python/ACP agent backend. It is not the Claude SDK
  backend, not the Pi SDK backend, and not a generic Craft subprocess that may
  share another agent's runtime assumptions.
- Hermes config/state is isolated in app-scoped `HERMES_HOME` under Electron
  `userData`; it never reads or writes the user's standalone `~/.hermes` unless
  a developer explicitly runs a standalone Hermes outside Craft.
- Hermes Python is isolated in the vendored venv under
  `apps/electron/resources/vendor/hermes/hermes-venv`; packaged builds must not
  fall back to a system `hermes` binary.
- Hermes receives Craft source tools and session tools only through ACP
  `session.mcpServers` pointing at Craft-owned, local-only MCP bridges. Do not
  move Craft-native tools into a static Hermes `mcp.json`, because that mixes
  global Hermes config with per-Craft-session capabilities.
- Hermes' tool names at the boundary are deliberate: Craft-native session tools
  stay `mcp__session__…`; Craft source tools stay `mcp__<source>__…`; external
  MCP servers keep normal Hermes names such as `mcp_filesystem_read_file`.
- Hermes must not reuse generic Craft mini-model fallbacks as its own native
  provider/model configuration. Provider/model state is resolved by the Hermes
  backend and its app-scoped config/profile.
- Packaged apps must not mutate the signed runtime. Dev mode may update and
  rebuild the local bundle; release updates come through a new Craft build.
- Auth bridging is intentionally scoped: at spawn, Craft seeds Hermes with the
  user's selected Craft credentials (OAuth tokens and API-key env vars) so the
  embedded runtime works without a separate Hermes `.env`; refreshed Codex
  tokens flow back Hermes → Craft via the `auth.json` watcher. Do not make
  Hermes scrape unrelated agent credentials or global user auth stores.
- Hermes is a **pinned upstream dependency plus Craft overlay patches**, not a
  hand-merged fork. In dev, the pin may be `upstream/main` for automatic
  dashboard updates; when upstream changes break an overlay, refresh the patch
  rather than switching the architecture to a user fork or another agent path.

## Why embedded

Previously `HermesAgent` spawned `hermes acp` from the user's PATH. If the user
did not have Hermes installed, sessions failed. Embedding gives:

- Single-install UX (DMG / NSIS / AppImage). No external dependency.
- App-scoped state under `userData/hermes` (isolated from `~/.hermes`).
- Versioning tied to Craft releases — `electron-updater` handles updates.
- A stable ACP runtime that can be inspected in Settings.

## Architecture

```
+-------------------------------------------------------------+
|  Craft Agents.app / craft-agents executable                 |
|                                                             |
|  Main process (Electron, Node)                              |
|     index.ts                                                |
|       └─ publishHermesRuntimeEnv()  ← handlers/hermes-runtime
|             • resolves vendor/hermes paths                  |
|             • patches pyvenv.cfg (relocation)               |
|             • exports CRAFT_HERMES_* env vars               |
|                                                             |
|  Shared (TypeScript)                                        |
|     packages/shared/src/hermes/acp-config.ts                |
|       └─ normalizeHermesRuntimeConfig()                     |
|             reads CRAFT_HERMES_PYTHON / ARGS / HOME         |
|                                                             |
|  HermesAgent (packages/shared/src/agent/hermes-agent.ts)    |
|     └─ createACPProvider({ command, args, env })            |
|             ↓ spawns                                        |
+-------------------------------------------------------------+
                                ↓ stdio (ACP JSON-RPC)
+-------------------------------------------------------------+
|  Bundled Python subprocess                                  |
|     vendor/hermes/hermes-venv/bin/python3 -m acp_adapter    |
|       • imports site-packages copy of hermes_agent          |
|       • talks ACP over stdin/stdout                         |
|       • routes MCP tool calls back to Craft over HTTP        |
+-------------------------------------------------------------+
```

Transport stays ACP stdio for agent sessions (Craft already speaks ACP via
`@mcpc-tech/acp-ai-provider`). atomic-hermes uses HTTP/WebSocket for chat
because its renderer talks Python directly; here the Node main process is the
agent bridge. Source tools and Craft-native session tools are exposed to Hermes
through local-only MCP Streamable HTTP bridges owned by Craft. The optional
Hermes web dashboard is also HTTP, but it is launched on demand from Settings
and opened inside Craft's embedded browser window.

## Bundle layout

After `bun run bundle:hermes`, `apps/electron/resources/vendor/hermes/`
contains:

```
vendor/hermes/
├── python/                # uv-installed CPython 3.13 (relocatable)
│   └── bin/python3
├── hermes-venv/           # venv created from python/, with Hermes installed
│   ├── bin/
│   │   ├── python3 → ../../python/bin/python3   (relative symlink)
│   │   └── python  → python3                    (relative symlink)
│   ├── pyvenv.cfg          # home = ../python/bin (rewritten at runtime)
│   └── lib/python3.13/site-packages/
│       └── hermes_agent/   # non-editable install: real source copy
├── hermes-agent/          # source mirror (skills, plugins, configs at runtime)
│   └── hermes_cli/web_dist/ # built Hermes dashboard SPA, when available
└── bin/
    └── rg                 # ripgrep, prepended to PATH
```

In packaged builds these land at `<app>/Contents/Resources/app/vendor/hermes/`
on macOS and the equivalent on Windows / Linux. This `app/vendor/hermes`
location is intentional: it keeps the symlink-heavy Python runtime out of
`dist/resources` and gives the macOS signing hook a stable path to clean and
codesign.

### Repository seed layout

Craft-specific Hermes knowledge that must exist for a fresh install lives in
`apps/electron/resources/hermes-seed/` instead of the generated runtime bundle:

```txt
resources/hermes-seed/
├── manifest.json
├── README.md
└── skills/
    └── craft-embedded-runtime/SKILL.md
```

`packages/shared/src/hermes/seed.ts` copies these seeds into the app-scoped
`HERMES_HOME` on launch via `ensureHermesSeedSkills()` from
`apps/electron/src/main/index.ts`. Copy policy is conservative:

- copy when the target skill is missing;
- skip when the user already has a file, preserving local edits;
- no secrets or Guilherme-specific local provider config in seed files;
- future overwrites must be explicit version migrations in `manifest.json`.

In packaged builds the seed folder remains under
`<app>/Contents/Resources/app/dist/resources/hermes-seed/` and must be present
alongside the runtime.

## Build flow

```
                                  +--------------------------+
  bun run bundle:hermes  ───────► |  scripts/bundle-hermes.* |
                                  +--------------------------+
                                              ↓
                  apps/electron/resources/vendor/hermes/  (generated runtime)
                                              ↓
                                  +--------------------------+
  bun scripts/copy-assets.ts ───► | dist/resources/          |
                                  | includes hermes-seed     |
                                  | excludes vendor/hermes   |
                                  +--------------------------+
                                              ↓
                                  +--------------------------+
  bun run dist:mac       ───────► |   electron-builder       |
                                  |   extraResources copy    |
                                  |   to app/vendor/hermes   |
                                  +--------------------------+
                                              ↓
                                  +--------------------------+
                                  | scripts/afterPack.cjs    |
                                  |  └─ afterPack-hermes.cjs |
                                  |     signs app/vendor/... |
                                  +--------------------------+
                                              ↓
                            DMG / NSIS / AppImage with bundled Hermes
```

### `scripts/bundle-hermes.sh` (macOS / Linux)

1. `uv python install 3.13` → copies the standalone Python into `vendor/hermes/python/`.
2. `python3 -m venv` creates `hermes-venv/` from the bundled Python.
3. `uv pip install <HERMES_SRC>[web,acp]` (non-editable) installs Hermes,
   the web dashboard dependencies, and `agent-client-protocol` into the venv.
   The bundle then installs the Google Meet bot runtime dependencies
   (`playwright`, `websockets`) and Playwright Chromium into the same venv.
   Relocatable: no egg-link with absolute paths.
4. Removes transient `HERMES_SRC/build/` output if the Python install created it.
5. Mirrors a curated subset of Hermes source (`agent/`, `tools/`,
   `acp_adapter/`, `hermes_cli/`, `gateway/`, `plugins/`, `skills/`, etc.)
   into `vendor/hermes/hermes-agent/` for runtime config / skill loading.
6. Builds/copies `hermes_cli/web_dist` into the mirrored source so the dashboard can run from the packaged app.
7. Downloads platform-specific ripgrep into `vendor/hermes/bin/rg`.
8. Strips `__pycache__`, `*.pyc`, `*.a`, broken symlinks, fake `.app` dirs.
9. Patches `pyvenv.cfg` to `home = ../python/bin` and rewrites venv `bin/`
   symlinks to relative form (codesign rejects absolute or out-of-bundle
   targets).

Before these bundling steps, the script resolves the pin into the cache clone
and applies every `apps/electron/scripts/hermes-patches/*.patch` file in
numeric order. `HERMES_SRC` has no default; when explicitly set to an existing
checkout it bypasses the cache and patch overlay for active Hermes development.

### `scripts/bundle-hermes.ps1` (Windows)

Same flow, ScriptBlock-based, uses `Scripts/python.exe` venv layout.

## Source checkout setup

The bundle path does **not** require a sibling `hermes-agent` checkout. The
update script clones upstream into `apps/electron/scripts/.hermes-cache/source`
on first run and reuses it on subsequent updates. No manual git setup needed.

Explicit dev mode (`HERMES_SRC` override) — useful only when iterating on
Hermes itself before turning the change into an overlay patch. This is not the
dashboard Update path:

```bash
# Point the bundle at any local Hermes checkout, skipping cache + patches.
HERMES_SRC=/tmp/hermes-agent-dev \
  bash apps/electron/scripts/update-hermes-runtime.sh
```

## Updating Hermes (the user-facing path)

Just click "Update Hermes" in the dashboard, or run:

```bash
bash apps/electron/scripts/update-hermes-runtime.sh
```

That:

1. Reads the pin from `apps/electron/scripts/hermes-version.txt`
   (or the `HERMES_VERSION` env override).
2. Clones (first run) or fetches (subsequent runs) NousResearch upstream into
   the Craft-owned cache.
3. Detaches the cache to the pin and resets it hard — any leftover patch from
   a previous bundle is wiped out so the run is reproducible.
4. Applies overlay patches from `apps/electron/scripts/hermes-patches/` in
   numeric order, with `git apply --check` first to catch upstream drift.
5. Calls `bundle-hermes.sh` to rebuild
   `apps/electron/resources/vendor/hermes/`.
6. Smoke-tests `acp_adapter` and `acp_adapter.server` import.

A user fork at `../hermes-agent` is not consulted. The only exception is an
explicit `HERMES_SRC=/path/to/hermes-agent` override for temporary Hermes
source development; do not leave that env set for Craft validation, dashboard
Update, or packaging.

## Patch refresh contract

When `git apply --check` fails after a pin bump, upstream changed the lines a
patch targets. The bundle aborts so a stale-bundle never ships. Refresh:

1. Inspect the failing file in the cache at the new pin.
2. Re-apply the intended Craft change manually in the cache.
3. Capture the new diff back into the corresponding `NN-name.patch` file:
   ```bash
   git -C apps/electron/scripts/.hermes-cache/source diff -- <files…> \
     > apps/electron/scripts/hermes-patches/NN-name.patch
   ```
4. Commit the refreshed patch in the Craft repo.

The pin file itself doesn't change for patch refreshes while tracking
`upstream/main` — it changes only when intentionally selecting a fixed Hermes
version for a reproducible build/release.

After every Hermes upstream sync, run at minimum:

From the Craft repo root:

```bash
# Python-side tests: run from your HERMES_SRC checkout, or from the patched
# cache after bundle apply.
cd apps/electron/scripts/.hermes-cache/source
uv run --extra dev --extra acp python -m pytest \
  tests/acp/test_server.py -k "mcp" \
  tests/tools/test_mcp_tool.py -k "craft or converts_mcp_tool_to_hermes_schema"

# Craft-side tests: run from the Craft repo root.
cd - >/dev/null
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

Then verify the bundled runtime exposes the same names:

```bash
apps/electron/resources/vendor/hermes/hermes-venv/bin/python3 - <<'PY'
from tools.mcp_tool import _mcp_tool_to_hermes_tool

print(_mcp_tool_to_hermes_tool("craft-session", {"name": "browser_tool", "description": "", "inputSchema": {"type": "object"}})["function"]["name"])
print(_mcp_tool_to_hermes_tool("craft-sources", {"name": "github__search_issues", "description": "", "inputSchema": {"type": "object"}})["function"]["name"])
print(_mcp_tool_to_hermes_tool("filesystem", {"name": "read_file", "description": "", "inputSchema": {"type": "object"}})["function"]["name"])
PY
```

Expected output:

```text
mcp__session__browser_tool
mcp__github__search_issues
mcp_filesystem_read_file
```

## Dev update flow

Hermes updates are initiated from the native Hermes dashboard. Craft Settings
only launches the dashboard and displays runtime state; it does not expose a
separate update button.

When the dashboard is running from Craft's bundled Hermes runtime,
`packages/server-core/src/handlers/rpc/hermes.ts` marks the process with
`CRAFT_HERMES_EMBEDDED=1` and passes the host update command through
`CRAFT_HERMES_UPDATE_COMMAND_JSON`. The dashboard's `/api/hermes/update`
endpoint delegates to that command instead of running `hermes update` inside
the generated source mirror, because the mirror under
`apps/electron/resources/vendor/hermes/hermes-agent/` intentionally has no
`.git` directory.

In development, the delegated command calls:

```bash
apps/electron/scripts/update-hermes-runtime.sh
apps/electron/scripts/update-hermes-runtime.ps1
```

The update script:

1. Resolves the pin (`HERMES_VERSION` env, or `apps/electron/scripts/hermes-version.txt`,
   or `upstream/main`).
2. If `HERMES_PERSIST_PIN=1` and `HERMES_VERSION` is set, writes the new pin
   back into the version file so future builds reproduce.
3. Hands off to `bundle-hermes.sh`, which:
   - Clones / fetches NousResearch upstream into `apps/electron/scripts/.hermes-cache/source`.
   - Detaches and hard-resets the cache to the pin.
   - Runs `git apply --check` then `git apply` for every patch under
     `apps/electron/scripts/hermes-patches/*.patch`.
   - Installs `[web,acp]` extras into a fresh relocatable venv.
   - Mirrors the patched source into `apps/electron/resources/vendor/hermes/hermes-agent/`.
   - Smoke-tests `acp_adapter` and `acp_adapter.server` import.

User forks, including `guilhermexp/hermes-agent` or sibling
`../hermes-agent`, are not consulted here. Only an explicit temporary
`HERMES_SRC=/path/to/hermes-agent` override changes the source, and that
override is outside the dashboard Update/release path.

After the dashboard-triggered update exits, Hermes writes
`$HERMES_HOME/craft-hermes-update-result.json`. Craft watches that marker and
shows an Electron notification asking the user to restart Craft when the update
succeeds, because the running Python runtime was already launched from the old
bundle.

Packaged apps do not receive `CRAFT_HERMES_UPDATE_COMMAND_JSON`. In that mode,
the dashboard update endpoint returns a managed-runtime error and the signed app
bundle must be updated through Craft releases.

## Release/package flow

The Electron distribution commands rebuild Hermes before packaging and then
validate the packaged app before producing/accepting release artifacts:

```bash
bun run electron:dist
bun run electron:dist:mac
bun run electron:dist:linux
bun run electron:dist:dev:mac
bun run electron:dist:dev:linux
```

Windows uses the PowerShell bundle:

```bash
bun run electron:dist:win
bun run electron:dist:dev:win
```

The lower-level release scripts also bundle Hermes before `electron-builder`:

- `apps/electron/scripts/build-dmg.sh`
- `apps/electron/scripts/build-win.ps1`
- `scripts/build/darwin.ts`

This is required because `apps/electron/resources/vendor/hermes/` is generated.
If packaging skips the bundle step, the app may resolve a stale or missing
runtime.

### Release inclusion rules

- `apps/electron/electron-builder.yml` ships the generated runtime through
  `extraResources` from `resources/vendor/hermes` to `app/vendor/hermes`.
- `apps/electron/scripts/copy-assets.ts` clears `dist/resources`, copies normal
  resources and `hermes-seed`, and deliberately excludes `resources/vendor/hermes`
  plus dev-only `resources/vendor/hermes-agent` so the runtime is not duplicated
  under `dist/resources`. The root `scripts/electron-build-resources.ts` and
  `scripts/electron-dev.ts` resource-copy paths mirror the same exclusion.
- `asar` remains disabled for this app so the embedded Python interpreter,
  symlinks, ripgrep, Playwright assets, and Hermes source mirror are available
  directly on disk.
- macOS architecture is selected by the build command (`--arm64` or `--x64`). Do
  not list both archs in `electron-builder.yml` while the embedded Hermes bundle
  is architecture-specific.

Required macOS packaged paths:

```txt
Contents/Resources/app/vendor/hermes/hermes-venv/bin/python3
Contents/Resources/app/vendor/hermes/hermes-agent/acp_adapter/server.py
Contents/Resources/app/dist/resources/hermes-seed/manifest.json
```

Forbidden duplicate path:

```txt
Contents/Resources/app/dist/resources/vendor/hermes
```

`build-dmg.sh` and `scripts/build/darwin.ts` fail closed when any required path
is missing or the duplicate runtime path exists. After a successful macOS build,
a smoke test should import at least `acp_adapter.server` and `hermes_cli` using
the Python inside the packaged `.app`; importing only `acp_adapter` is too weak.

### `scripts/afterPack-hermes.cjs`

Runs only on macOS, after electron-builder copies extraResources. The target is
`Contents/Resources/app/vendor/hermes` inside the packaged `.app`:

- Removes broken symlinks (codesign --verify rejects them).
- Converts remaining absolute symlinks inside the bundle to relative ones.
- Removes symlinks pointing outside the bundle.
- Recreates the `python3 → ../../python/bin/python3` chain inside
  `hermes-venv/bin` if it was wiped by the previous step.
- Renames fake `.app` directories (e.g. test fixtures from third-party
  packages) so codesign doesn't try to sign them as app bundles.
- Walks `vendor/hermes/{python,hermes-venv,bin}` and codesigns every
  Mach-O binary using the same identity electron-builder uses for the
  outer .app, with the same entitlements.

`afterPack.cjs` chains both the existing Liquid Glass icon copy AND
`afterPack-hermes.cjs`, so electron-builder's single-entry `afterPack`
keeps both behaviors.

## Runtime path resolution

`apps/electron/src/main/handlers/hermes-runtime.ts` is the single source of
truth for "where is the bundled Hermes?":

| Env var                       | Source                                          |
| ----------------------------- | ----------------------------------------------- |
| `CRAFT_HERMES_PYTHON`         | `vendor/hermes/hermes-venv/bin/python3`         |
| `CRAFT_HERMES_ARGS`           | `JSON.stringify(['-m', 'acp_adapter'])`         |
| `CRAFT_HERMES_HOME`           | `app.getPath('userData') + '/hermes'`           |
| `CRAFT_HERMES_AGENT_ROOT`     | `vendor/hermes/hermes-agent`                    |
| `CRAFT_HERMES_VIRTUAL_ENV`    | `vendor/hermes/hermes-venv`                     |
| `CRAFT_HERMES_VENDOR_BIN`     | `vendor/hermes/bin`                             |
| `PATH` prepend                | `vendor/hermes/bin` (ripgrep)                   |

Packaged build: paths anchor on `process.resourcesPath/app/`.
Dev build: paths anchor on `apps/electron/resources/vendor/hermes/`.

If the bundled Python is missing (e.g., contributor never ran
`bundle:hermes`), `hermes-runtime.ts` logs a warning and skips publishing
the env vars. `acp-config.ts` then falls back to the legacy PATH-based
`hermes` resolution, so dev builds without bundling still work.

`acp-config.ts` only pairs `CRAFT_HERMES_ARGS` with `CRAFT_HERMES_PYTHON` —
running an external `hermes` binary with `-m acp_adapter` would crash, so the
runtime config is treated as a single coherent unit.

Runtime smoke checks:

```bash
apps/electron/resources/vendor/hermes/hermes-venv/bin/python3 \
  -c "import acp, acp_adapter.server; print('acp ok')"

apps/electron/resources/vendor/hermes/hermes-venv/bin/python3 \
  -m py_compile apps/electron/resources/vendor/hermes/hermes-agent/acp_adapter/server.py
```

Both must pass. `import acp_adapter` alone is not enough because it does not
prove that the ACP protocol package is installed.

### `pyvenv.cfg` relocation

`pyvenv.cfg` ships with `home = ../python/bin`. CPython accepts relative paths
on most platforms, but to be defensive across DMG installs and AppImage
mounts, `hermes-runtime.ts` rewrites the `home` line to the absolute current
path on first launch (and any time the app moves). Single-line patch, no
restart of the user's session.

## Dashboard/model configuration UX

`packages/server-core/src/handlers/rpc/hermes.ts` exposes local-only Hermes runtime controls:

- `hermes:detectInstallation` — reports bundled/system runtime, app-scoped `HERMES_HOME`, discovered providers/models, version, and config paths. In packaged builds, a missing bundled runtime is reported as unavailable; it must not silently resolve to a user-installed `hermes` binary.
- `hermes:getRuntimeDetails` — extends detection with config/env existence,
  app-scoped logs/skills/sessions paths, source repo path, origin/upstream
  remotes, branch, commit, commit date, release tag, dirty state, available
  providers, and plugin names.
- `hermes:startDashboard` — starts `python -m hermes_cli.main dashboard --no-open` for bundled Hermes (or `hermes dashboard --no-open` for system Hermes), passes Craft embedded update env when applicable, watches the update marker, waits for a free localhost port, then returns the URL. In Electron GUI mode the handler also delegates visual mount/reuse to `apps/electron/src/main/hermes-dashboard-host/`; renderer callers receive only status and the safe localhost URL, never internal tokens or provider secrets.
- `hermes:updateRuntime` — legacy/dev-only helper that runs `apps/electron/scripts/update-hermes-runtime.*`; packaged apps return `unsupported` because signed bundles must be updated via Craft releases. The visible update entry point is the Hermes dashboard.
- `hermes:listLogs` / `hermes:readLog` — enumerate and tail app-scoped Hermes logs.
- `hermes:listHomeFiles` / `hermes:openPath` — browse/reveal files under `HERMES_HOME` only. Secrets (`.env`, `auth.json`, locks) are omitted, path traversal is blocked, and operational directories such as `sessions/`, `logs/`, `skills/`, `memories/`, and `cron/` are shown as collapsed top-level folders so Settings does not render raw session dumps.
- `hermes:listSkills` — lists installed Hermes skills from app-scoped `HERMES_HOME/skills`.
- `hermes:listProfiles`, `hermes:createProfile`, `hermes:renameProfile`,
  `hermes:getActiveProfile`, `hermes:setActiveProfile`,
  `hermes:deleteProfile`, `hermes:getProfileSetupCommand`,
  `hermes:getProfileSoul`, and `hermes:updateProfileSoul` proxy the dashboard
  `/api/profiles*` endpoints through the same authenticated embedded dashboard
  bridge. Settings may manage Hermes multi-agent profiles from the app, but the
  source of truth remains the app-scoped Hermes runtime/dashboard API. The
  active Craft chat profile is stored in Craft config as a profile name:
  `default` uses the base app-scoped `HERMES_HOME`, while non-default profiles
  run the Hermes ACP subprocess with `HERMES_HOME=<base>/profiles/<name>`.
- `hermes:listEnv`, `hermes:setEnv`, and `hermes:deleteEnv` proxy the dashboard
  `/api/env` endpoint so the AI Models tab can list optional Hermes env vars
  with `is_set`/redacted previews and write/clear secrets without leaving Craft.
  The handler runs through the same authenticated embedded-dashboard bridge as
  the profile RPCs and never reads or writes the user's standalone `~/.hermes`.

`Settings / AI` remains generic: connections, model defaults, thinking level, workspace overrides.
`Settings / Hermes` is the Hermes-specific operational page organized in tabs:
**Runtime Hermes**, **Provider & Modelo**, **Profiles**, **Messengers**,
**Skills do Hermes**, and **Logs**. Each non-runtime tab is its own component
(`HermesAiModelsConfig`, `HermesProfilesConfig`, `HermesMessengersConfig`,
`HermesSkillsConfig`, `HermesLogsConfig`) so the page can grow without turning
back into a single giant file.
Clicking **Abrir Dashboard Hermes** launches the dashboard and opens the returned localhost URL in the existing Craft embedded browser with `browserPane.create({ url, show: true })`, not in the OS default browser.

### Version display

The Hermes Settings card must show the runtime version directly, for example:

```text
Hermes Agent v0.11.0 (2026.4.23) · upstream synced · 1d4218be
```

Source of each field:

| UI field | Source |
| -------- | ------ |
| `0.11.0` | `from hermes_cli import __version__` in the bundled venv, or `hermes --version` for system Hermes |
| `2026.4.23` | exact Git tag on the Hermes source checkout, e.g. `v2026.4.23`; fallback is `git log -1 --format=%cs` |
| `upstream synced` | `sourceRepoUpstreamRemote` exists, meaning `upstream` is configured |
| `1d4218be` | `git rev-parse --short HEAD` in the Craft-owned cache, or in an explicit temporary `HERMES_SRC` override |
| `+dirty` | `git status --porcelain` is non-empty |

The repo row still shows the fork remote and commit separately. The version
row is the human-readable health line.

### Config count caveat

`providerCount: 0` and `modelCount: 0` in logs do not mean the runtime is
missing. They mean the app-scoped `HERMES_HOME/config.yaml` does not define
providers/models yet. Hermes can still be installed and active. Configure
providers through the Hermes dashboard or by creating config in the isolated
`HERMES_HOME`.

## Craft-native tools for Hermes

Hermes sessions now receive two separate local MCP endpoints in their ACP
`session.mcpServers` array:

| MCP name | Owner | Purpose |
| -------- | ----- | ------- |
| `craft-sources` | existing `McpPoolServer` | Workspace source tools (GitHub, Linear, Notion, etc.) through the shared source pool. |
| `craft-session` | `CraftSessionToolsMcpServer` | Craft-native session tools: plan/auth/config helpers, `call_llm`, `spawn_session`, session metadata tools, `browser_tool`, `automation_tool`, and `meeting_tool`. |

This is intentionally Hermes-only wiring in `HermesAgent`; Claude and Pi keep
their existing adapters. The bridge reuses the same session callback registry
that powers native agents, so Electron-provided browser functions and
self-management callbacks stay late-bound and session-scoped.

ACP model switching is part of the contract. Craft sets the selected model
through ACP after session creation, and Hermes also supports `/model`. Both
paths recreate the underlying Python `AIAgent`, so Hermes must keep the
ACP-provided `mcpServers` on `SessionState` and reapply the `mcp-<server>`
toolsets after the agent is rebuilt. Without that, logs can show MCP
registration succeeded and still leave the prompt without `craft-session`
tools after the model switch.

Craft session/source tools must also keep Craft's canonical tool names inside
Hermes: `mcp__session__browser_tool`, `mcp__session__spawn_session`,
`mcp__session__call_llm`, and source tools such as `mcp__github__search_issues`.
Hermes normally prefixes MCP tools as `mcp_<server>_<tool>`; the embedded fork
special-cases `craft-session` and `craft-sources` so these tools pass through
the same permission, prerequisite, logging, and UI paths as Pi/Claude tools
instead of looking like unrelated external MCP tools.

Hermes normal session turns also receive a hidden `<<craft-session-context>>`
block before the user's text. This is separate from the richer War Room
`<<craft-channel-orchestrator>>` packet: the normal-session envelope resolves
session labels against workspace labels and War Room channel `labelId`/name/id,
then injects the active channel/client, session status, working directory,
source hints, and a privacy boundary. This prevents a chat visually opened in a
client channel (for example `#certfacil`) from starting as a contextless Hermes
conversation.

Hermes tool approvals are intentionally handled by Craft's UI. The Hermes ACP
server emits `session/request_permission`; `HermesAgent` converts that to the
normal Craft permission request callback, and `respondToPermission` resolves
the ACP option (`allow_once`, `allow_always`, or reject). Do not rely on the
ACP provider's default permission behavior, because without an explicit client
handler it may select the first option instead of pausing for the user.

Important separation rules:

- No Craft internals are injected into Hermes Python. Hermes only sees MCP.
- `craft-sources` and `craft-session` are local-only `127.0.0.1` endpoints.
- `browser_tool` uses Craft's built-in browser abstraction, not an external OS browser.
- Scheduled-task creation goes through `automation_tool`, which writes Craft `automations.json` and reloads the active `AutomationSystem`; Hermes' native `HERMES_HOME/cron/jobs.json` should remain disabled/hidden in Craft context.
- Meeting control goes through `meeting_tool`, which only forwards `start`, `status`, `list`, `transcript`, and `stop` to session-scoped Craft-native meeting callbacks when a native runtime has registered them; otherwise it fails closed with an unavailable error. Google Meet bot startup is delegated to Hermes' `google_meet` plugin through Craft's native meeting service and requires a dedicated Playwright storage state at `<HERMES_HOME>/workspace/meetings/bot-auth.json`; do not reuse the meeting organizer's visible BrowserPane cookies as the bot identity. The Browser Pane toolbar can hand an already-open Meet tab to `MeetingService.start({ browserInstanceId })` so the user keeps their visible session while the bot joins as a separate Playwright participant; the bundle ships `playwright` + `websockets` + Chromium inside `hermes-venv` and `apps/electron/scripts/create-meet-bot-auth.py` is the helper to mint `bot-auth.json` from a dedicated Google account.

## Session and configuration isolation

- `HERMES_HOME` resolves to `<userData>/hermes`, NOT the Craft repo and NOT
  `~/.hermes`. A user with
  a standalone Hermes install is fully isolated.
- This matches the `atomic-hermes` desktop reference, which resolves
  `getHermesHome()` as `path.join(app.getPath("userData"), "hermes")` and
  creates `memory/`, `sessions/`, `skills/`, and `skins/` there.
- ACP sessions persist to `<userData>/hermes/state.db` through Hermes'
  `SessionDB`. The upstream ACP session manager calls
  `SessionDB(db_path=get_hermes_home() / "state.db")`, creates/updates the
  `sessions` row, and replaces the stored messages after prompts complete.
- Files under `<userData>/hermes/sessions/` are Hermes sidecar/debug/legacy
  transcript files such as `session_*.json`, `.jsonl`, or
  `request_dump_*.json`. They are user data, not generated release assets, and
  must not be committed or copied into `apps/electron/resources/vendor/hermes/`.
- Migration from `~/.hermes` is intentionally not automatic. If we want it
  later, do a one-time opt-in dialog on first launch.
- `<userData>` on macOS dev builds can be:
  `~/Library/Application Support/@craft-agent/electron/hermes`.

## Updates

- The whole bundle ships inside the app; `electron-updater` handles packaged
  app versioning. No `git pull` or `uv sync` inside signed packaged apps.
- Bumping the bundled Hermes version in dev:
  ```bash
  HERMES_VERSION=v2026.4.23 HERMES_PERSIST_PIN=1 \
    bash apps/electron/scripts/update-hermes-runtime.sh
  ```
  Or click "Update Hermes" in the dashboard (defaults to `upstream/main` from
  `apps/electron/scripts/hermes-version.txt`).
- After a pin bump, commit the updated `hermes-version.txt` and any refreshed
  `hermes-patches/*.patch` files. Do not commit the regenerated bundle under
  `apps/electron/resources/vendor/hermes/`; it is gitignored generated output
  and distribution scripts rebuild it from `(pin + patches)`.
- Local dev: `update-hermes-runtime.*`. Packaged apps: rebuild and release —
  the runtime cannot mutate itself in a signed bundle.

## HermesAgent lifecycle hardening

Embedded runtime exposed two latent races that are now fixed in
`packages/shared/src/agent/hermes-agent.ts`:

### `setSourceServers` no longer kills mid-stream sessions

Previously every source change called `provider.cleanup()` unconditionally,
which terminates the ACP subprocess. If a config watcher or token refresh
fired during a streaming response, the user saw a truncated turn with no
recovery event. Now:

- The new descriptor set is diffed against the current one. If the keys are
  identical, no restart happens.
- If a stream is active (`isStreaming === true`), the restart is queued via
  `pendingProviderRestart` and applied in the `chatImpl` `finally` block once
  the turn ends.

### `postInit` no longer double-syncs the MCP pool

`SessionManager` already calls `mcpPool.sync(...)` before constructing the
agent when `needsHttpPoolServer` is true. The previous `postInit` then called
`setSourceServers` → `super.setSourceServers` → `mcpPool.sync` again, which
duplicated the work and raced against the freshly started ACP subprocess.
`postInit` now skips the redundant sync when `poolServerUrl` is set and only
updates `SourceManager` state.

## Tests

- `packages/shared/src/hermes/__tests__/acp-config.test.ts`
  - Covers default external-`hermes` path, bundled `CRAFT_HERMES_PYTHON +
    CRAFT_HERMES_ARGS` pickup, args pairing safety, explicit overrides,
    `CRAFT_HERMES_HOME` precedence over `HERMES_HOME`, and combined
    `craft-sources` + `craft-session` MCP config.
- `packages/shared/src/mcp/session-tools-server.test.ts`
  - Covers canonical tool listing plus `call_llm`, `spawn_session`,
    late-bound session-management callbacks, `meeting_tool` callback/fallback
    behavior, and `automation_tool` create/list/toggle/delete behavior through
    the MCP bridge.
- `packages/shared/src/agent/__tests__/hermes-agent.test.ts`
  - No-op when descriptors unchanged.
  - Restart provider on descriptor change.
  - Defer restart while streaming, apply on stream completion.
  - `postInit` skips redundant pool sync when `poolServerUrl` is set.
  - `postInit` falls back to `setSourceServers` (with sync) when no pool URL.
- `../hermes-agent/tests/acp/test_server.py`
  - Covers ACP MCP registration and verifies `craft-session`-style MCP
    toolsets survive both ACP `session/set_model` and Hermes `/model`.
- `packages/server-core/src/handlers/rpc/hermes.test.ts`
  - `listHomeFiles` omits `.env`.
  - `openPath` blocks traversal outside `HERMES_HOME`.
  - `updateRuntime` returns `unsupported` in packaged apps.
  - `getRuntimeDetails` returns fork/upstream release metadata used by the
    Hermes Settings version row.
- `../hermes-agent/tests/hermes_cli/test_web_server.py`
  - Covers Craft-embedded dashboard update delegation and completion-marker
    writing for the Electron restart notification.

Run with:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/shared/src/agent/backend/__tests__/factory.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts

bun run typecheck:shared
```

Last recorded focused validation for this integration work before the
docs-only update:

```text
34 pass across the Hermes/Craft focused test set
Hermes Python ACP/MCP tests pass for the Craft-specific overlay patches
```

This is not a substitute for the upstream-sync checklist above. Craft no longer
tracks a user Hermes fork. If you temporarily used `HERMES_SRC` for Hermes
source work, unset it and re-run the update/bundle path against the pinned
NousResearch cache before relying on the result. Run `bun run typecheck:shared`
whenever TypeScript runtime wiring changes.

## File map

| File                                                                                                | Purpose                                              |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/electron/scripts/bundle-hermes.sh`                                                            | Build vendor/hermes from `(pin + overlay patches)` (mac/linux) |
| `apps/electron/scripts/bundle-hermes.ps1`                                                           | Build vendor/hermes (windows)                        |
| `apps/electron/scripts/update-hermes-runtime.sh`                                                     | Dev-only pin resolver + bundle wrapper (mac/linux)   |
| `apps/electron/scripts/update-hermes-runtime.ps1`                                                    | Dev-only pin resolver + bundle wrapper (windows)     |
| `apps/electron/scripts/hermes-version.txt`                                                          | Pinned upstream ref (single source of truth)         |
| `apps/electron/scripts/hermes-patches/*.patch`                                                      | Craft overlay patches applied at bundle time         |
| `apps/electron/scripts/.hermes-cache/source/`                                                        | Gitignored Craft-owned upstream clone for the build  |
| `apps/electron/scripts/afterPack-hermes.cjs`                                                        | Symlink cleanup + Mach-O signing                     |
| `apps/electron/scripts/afterPack.cjs`                                                               | Chains Liquid Glass icon + afterPack-hermes          |
| `apps/electron/src/main/handlers/hermes-runtime.ts`                                                 | Path resolver + env publisher                        |
| `apps/electron/src/main/index.ts`                                                                   | Calls `publishHermesRuntimeEnv()` on boot            |
| `apps/electron/electron-builder.yml`                                                                | extraResources entry per platform                    |
| `packages/shared/src/hermes/acp-config.ts`                                                          | `normalizeHermesRuntimeConfig`, ACP MCP shape mapper |
| `packages/shared/src/hermes/auth-bridge.ts`                                                         | Seed Craft `claude_oauth` / `llm_oauth::chatgpt-plus` into Hermes at spawn |
| `packages/shared/src/hermes/__tests__/auth-bridge.test.ts`                                          | Auth bridge tests (Claude env, Codex auth.json, active provider) |
| `packages/shared/src/mcp/session-tools-server.ts`                                                   | Local MCP bridge for Craft-native session tools      |
| `packages/shared/src/agent/hermes-agent.ts`                                                         | Streaming-safe lifecycle + Hermes MCP wiring         |
| `packages/shared/src/agent/backend/hermes/event-adapter.ts`                                         | Normalizes Hermes ACP `text-delta` / `tool-call` / `tool-result` / `finish` events into Craft `AgentEvent`s, shared with the other backends' display logic |
| `packages/server-core/src/handlers/rpc/hermes.ts`                                                    | Runtime detection, dashboard launch, dashboard update env, marker watcher, logs, files, env CRUD |
| `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx`                                  | Hermes Settings operational UI shell (tabs)          |
| `apps/electron/src/renderer/pages/settings/HermesAiModelsConfig.tsx`                                | Provider + model picker, brand icons, env management |
| `apps/electron/src/renderer/pages/settings/HermesMessengersConfig.tsx`                              | Messengers tab content                               |
| `apps/electron/src/renderer/pages/settings/HermesSkillsConfig.tsx`                                  | Skills tab content                                   |
| `apps/electron/src/renderer/pages/settings/HermesLogsConfig.tsx`                                    | Logs tab content                                     |
| `packages/shared/src/hermes/__tests__/acp-config.test.ts`                                           | Resolver/MCP config tests                            |
| `packages/shared/src/mcp/session-tools-server.test.ts`                                              | Craft session tools MCP tests                        |
| `packages/shared/src/agent/__tests__/hermes-agent.test.ts`                                          | Lifecycle tests                                      |
| `packages/server-core/src/handlers/rpc/hermes.test.ts`                                               | Runtime details, path safety, packaged update tests  |

## Quickstart

No Hermes checkout required. Bundle script self-clones upstream into a cache.

```bash
# Build / refresh the embedded Hermes runtime against the pin in
# apps/electron/scripts/hermes-version.txt:
bash apps/electron/scripts/update-hermes-runtime.sh

# Bump the pin to a specific upstream tag and persist it:
HERMES_VERSION=v2026.4.23 HERMES_PERSIST_PIN=1 \
  bash apps/electron/scripts/update-hermes-runtime.sh

# Optional dev path: bundle from your own Hermes checkout, skipping the cache
# clone and overlay patches (use only for active Hermes development):
HERMES_SRC=/tmp/hermes-agent-dev \
  bash apps/electron/scripts/update-hermes-runtime.sh

# Build the embedded runtime
cd ~/Documents/Projetos/SelfHosting/craft-agents-oss/apps/electron
bun run bundle:hermes              # macOS / Linux
# or
bun run bundle:hermes:win          # Windows (pwsh)

# Dev mode from repo root (uses vendor/hermes from this checkout)
cd ~/Documents/Projetos/SelfHosting/craft-agents-oss
bun dev:desktop

# Lower-level Electron dev command
cd apps/electron
bun run dev

# Distribution build (signs Mach-O, requires CSC_NAME or auto-discovery)
bun run dist:mac                   # arm64
bun run dist:mac:x64               # x64
bun run dist:win
```

## Out of scope (next iterations)

- Auto-import of an existing `~/.hermes/config.yaml`. Right now configs are
  fully isolated.
- ARM Linux ripgrep target — the bundle script silently skips ripgrep on
  unsupported platform combos. Add explicit handling when a target is needed.
