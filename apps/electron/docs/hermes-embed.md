# Hermes Agent — Embedded Runtime

Craft Agents bundles the Hermes Python agent inside the Electron app. The
runtime ships as `extraResources`, runs as an ACP stdio subprocess, and does
not require the user to install `hermes` separately.

Reference implementation: [`atomic-hermes/desktop`](https://github.com/AtomicBot-ai/atomic-hermes).
Hermes upstream: [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).

## Why embedded

Previously `HermesAgent` spawned `hermes acp` from the user's PATH. If the user
did not have Hermes installed, sessions failed. Embedding gives:

- Single-install UX (DMG / NSIS / AppImage). No external dependency.
- App-scoped state under `userData/hermes` (isolated from `~/.hermes`).
- Versioning tied to Craft releases — `electron-updater` handles updates.

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
on macOS and the equivalent on Windows / Linux.

## Build flow

```
                                  +--------------------------+
  bun run bundle:hermes  ───────► |  scripts/bundle-hermes.* |
                                  +--------------------------+
                                              ↓
                  apps/electron/resources/vendor/hermes/  (built once)
                                              ↓
                                  +--------------------------+
  bun run dist:mac       ───────► |   electron-builder       |
                                  |   (extraResources copy)  |
                                  +--------------------------+
                                              ↓
                                  +--------------------------+
                                  | scripts/afterPack.cjs    |
                                  |  └─ afterPack-hermes.cjs |
                                  +--------------------------+
                                              ↓
                            DMG / NSIS / AppImage with signed bundle
```

### `scripts/bundle-hermes.sh` (macOS / Linux)

1. `uv python install 3.13` → copies the standalone Python into `vendor/hermes/python/`.
2. `python3 -m venv` creates `hermes-venv/` from the bundled Python.
3. `uv pip install <HERMES_SRC>` (non-editable) → site-packages owns the
   Hermes source. Relocatable: no egg-link with absolute paths.
4. Mirrors a curated subset of Hermes source (`agent/`, `tools/`,
   `acp_adapter/`, `hermes_cli/`, `gateway/`, `plugins/`, `skills/`, etc.)
   into `vendor/hermes/hermes-agent/` for runtime config / skill loading.
5. Builds/copies `hermes_cli/web_dist` into the mirrored source so the dashboard can run from the packaged app.
6. Downloads platform-specific ripgrep into `vendor/hermes/bin/rg`.
7. Strips `__pycache__`, `*.pyc`, `*.a`, broken symlinks, fake `.app` dirs.
8. Patches `pyvenv.cfg` to `home = ../python/bin` and rewrites venv `bin/`
   symlinks to relative form (codesign rejects absolute or out-of-bundle
   targets).

`HERMES_SRC` defaults to `../../hermes-agent` relative to the repo root —
clone the upstream repo there, or override via env var.

### `scripts/bundle-hermes.ps1` (Windows)

Same flow, ScriptBlock-based, uses `Scripts/python.exe` venv layout.

### `scripts/afterPack-hermes.cjs`

Runs only on macOS, after electron-builder copies extraResources:

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

### `pyvenv.cfg` relocation

`pyvenv.cfg` ships with `home = ../python/bin`. CPython accepts relative paths
on most platforms, but to be defensive across DMG installs and AppImage
mounts, `hermes-runtime.ts` rewrites the `home` line to the absolute current
path on first launch (and any time the app moves). Single-line patch, no
restart of the user's session.

## Dashboard/model configuration UX

`packages/server-core/src/handlers/rpc/hermes.ts` exposes local-only Hermes runtime controls:

- `hermes:detectInstallation` — reports bundled/system runtime, app-scoped `HERMES_HOME`, discovered providers/models, and config paths.
- `hermes:getRuntimeDetails` — extends detection with config/env existence and app-scoped logs/skills/sessions paths.
- `hermes:startDashboard` — starts `python -m hermes_cli.main dashboard --no-open` for bundled Hermes (or `hermes dashboard --no-open` for system Hermes), waits for a free localhost port, then returns the URL.
- `hermes:updateRuntime` — dev-only helper that runs `apps/electron/scripts/update-hermes-runtime.*`; packaged apps return `unsupported` because signed bundles must be updated via Craft releases.
- `hermes:listLogs` / `hermes:readLog` — enumerate and tail app-scoped Hermes logs.
- `hermes:listHomeFiles` / `hermes:openPath` — browse/reveal files under `HERMES_HOME` only; `.env` is omitted from listings and path traversal is blocked.
- `hermes:listSkills` — lists installed Hermes skills from app-scoped `HERMES_HOME/skills`.

`Settings / AI` remains generic: connections, model defaults, thinking level, workspace overrides.
`Settings / Hermes` is the Hermes-specific operational page: **Atualizar Hermes**, **Abrir Dashboard Hermes**, **Ver logs**, **Files**, **Skills do Hermes**, and **Conectores do Hermes**.
Clicking **Abrir Dashboard Hermes** launches the dashboard and opens the returned localhost URL in the existing Craft embedded browser with `browserPane.create({ url, show: true })`, not in the OS default browser.

## Craft-native tools for Hermes

Hermes sessions now receive two separate local MCP endpoints in their ACP
`session.mcpServers` array:

| MCP name | Owner | Purpose |
| -------- | ----- | ------- |
| `craft-sources` | existing `McpPoolServer` | Workspace source tools (GitHub, Linear, Notion, etc.) through the shared source pool. |
| `craft-session` | `CraftSessionToolsMcpServer` | Craft-native session tools: plan/auth/config helpers, `call_llm`, `spawn_session`, session metadata tools, `browser_tool`, and `automation_tool`. |

This is intentionally Hermes-only wiring in `HermesAgent`; Claude and Pi keep
their existing adapters. The bridge reuses the same session callback registry
that powers native agents, so Electron-provided browser functions and
self-management callbacks stay late-bound and session-scoped.

Important separation rules:

- No Craft internals are injected into Hermes Python. Hermes only sees MCP.
- `craft-sources` and `craft-session` are local-only `127.0.0.1` endpoints.
- `browser_tool` uses Craft's built-in browser abstraction, not an external OS browser.
- Scheduled-task creation goes through `automation_tool`, which writes Craft `automations.json` and reloads the active `AutomationSystem`; Hermes' native `HERMES_HOME/cron/jobs.json` should remain disabled/hidden in Craft context.

## Session and configuration isolation

- `HERMES_HOME` resolves to `<userData>/hermes`, NOT `~/.hermes`. A user with
  a standalone Hermes install is fully isolated.
- Migration from `~/.hermes` is intentionally not automatic. If we want it
  later, do a one-time opt-in dialog on first launch.
- `<userData>` on macOS: `~/Library/Application Support/craft-agent/hermes`.

## Updates

- The whole bundle ships inside the app; `electron-updater` handles
  versioning. No `git pull` or `uv sync` at runtime.
- To bump the bundled Hermes commit, update the `hermes-agent` clone next
  to the repo (`HERMES_SRC`) to the desired ref, then re-run
  `bun run bundle:hermes`. Commit the resulting `vendor/hermes/` snapshot
  (or wire it as a CI step).

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
    late-bound session-management callbacks, and `automation_tool`
    create/list/toggle/delete behavior through the MCP bridge.
- `packages/shared/src/agent/__tests__/hermes-agent.test.ts`
  - No-op when descriptors unchanged.
  - Restart provider on descriptor change.
  - Defer restart while streaming, apply on stream completion.
  - `postInit` skips redundant pool sync when `poolServerUrl` is set.
  - `postInit` falls back to `setSourceServers` (with sync) when no pool URL.
- `packages/server-core/src/handlers/rpc/hermes.test.ts`
  - `listHomeFiles` omits `.env`.
  - `openPath` blocks traversal outside `HERMES_HOME`.
  - `updateRuntime` returns `unsupported` in packaged apps.

Run with:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/shared/src/agent/backend/__tests__/factory.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

## File map

| File                                                                                                | Purpose                                              |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/electron/scripts/bundle-hermes.sh`                                                            | Build vendor/hermes (mac/linux)                      |
| `apps/electron/scripts/bundle-hermes.ps1`                                                           | Build vendor/hermes (windows)                        |
| `apps/electron/scripts/afterPack-hermes.cjs`                                                        | Symlink cleanup + Mach-O signing                     |
| `apps/electron/scripts/afterPack.cjs`                                                               | Chains Liquid Glass icon + afterPack-hermes          |
| `apps/electron/src/main/handlers/hermes-runtime.ts`                                                 | Path resolver + env publisher                        |
| `apps/electron/src/main/index.ts`                                                                   | Calls `publishHermesRuntimeEnv()` on boot            |
| `apps/electron/electron-builder.yml`                                                                | extraResources entry per platform                    |
| `packages/shared/src/hermes/acp-config.ts`                                                          | `normalizeHermesRuntimeConfig`, ACP MCP shape mapper |
| `packages/shared/src/mcp/session-tools-server.ts`                                                   | Local MCP bridge for Craft-native session tools      |
| `packages/shared/src/agent/hermes-agent.ts`                                                         | Streaming-safe lifecycle + Hermes MCP wiring         |
| `packages/shared/src/hermes/__tests__/acp-config.test.ts`                                           | Resolver/MCP config tests                            |
| `packages/shared/src/mcp/session-tools-server.test.ts`                                              | Craft session tools MCP tests                        |
| `packages/shared/src/agent/__tests__/hermes-agent.test.ts`                                          | Lifecycle tests                                      |

## Quickstart

```bash
# Once: clone Hermes upstream next to craft-agents-oss
git clone https://github.com/NousResearch/hermes-agent.git \
  ~/Documents/Projetos/SelfHosting/hermes-agent

# Build the embedded runtime
cd apps/electron
bun run bundle:hermes              # macOS / Linux
# or
bun run bundle:hermes:win          # Windows (pwsh)

# Dev mode (uses vendor/hermes from this checkout)
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
