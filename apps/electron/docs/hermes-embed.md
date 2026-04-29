# Hermes Agent — Embedded Runtime

Craft Agents bundles the Hermes Python agent inside the Electron app. The
runtime ships as `extraResources`, runs as an ACP stdio subprocess, and does
not require the user to install `hermes` separately.

Reference implementation: [`atomic-hermes/desktop`](https://github.com/AtomicBot-ai/atomic-hermes).
Hermes upstream: [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).

## Current contract

Hermes inside Craft is maintained as a forked upstream dependency, not as a
hand-copied Python folder:

- The source checkout lives next to this repo: `../hermes-agent` from the
  `craft-agents-oss` root.
- `origin` must point at the Craft-maintained fork:
  `https://github.com/guilhermexp/hermes-agent.git`.
- `upstream` must point at the NousResearch repo:
  `https://github.com/NousResearch/hermes-agent.git`.
- Updates come from `upstream/main` by fast-forward only, then are pushed to
  `origin/main` after validation.
- The embedded runtime under `apps/electron/resources/vendor/hermes/` is a
  generated bundle. It is rebuilt from the source checkout.

This keeps the Hermes codebase isolated from other Craft agents while still
letting Hermes inherit Craft-native capabilities through MCP.

## Fork sync guardrails

There are two independent forks involved:

| Repo | Local path | Fork remote | Upstream remote |
| ---- | ---------- | ----------- | --------------- |
| Craft | `craft-agents-oss` | `origin` → `guilhermexp/craft-agents-oss` | `upstream` → `lukilabs/craft-agents-oss` |
| Hermes | `../hermes-agent` | `origin` → `guilhermexp/hermes-agent` | `upstream` → `NousResearch/hermes-agent` |

Always fetch both before changing the integration:

```bash
git fetch upstream --prune

cd ../hermes-agent
git fetch upstream --prune
```

Fetching is safe with a dirty worktree. Merging or fast-forwarding is not.
If either repo has local changes, stop after fetch and record the divergence:

```bash
git rev-list --left-right --count HEAD...upstream/main
git log --oneline HEAD..upstream/main -n 20
git log --oneline upstream/main..HEAD -n 20
```

Interpretation:

- `A B` means local `HEAD` has `A` commits not in upstream and upstream has
  `B` commits not in local `HEAD`.
- If `B > 0`, upstream has new work. Sync in a clean branch/worktree, then
  rebuild and validate the Hermes bundle.
- If `A > 0`, local fork work exists. Push/PR/track it separately before
  assuming the fork can be replaced by upstream.

Current check on 2026-04-29:

- Craft: `46 0` against `upstream/main`; no upstream commits waiting, local
  fork is ahead.
- Hermes: `0 39` against `upstream/main`; upstream has 39 commits waiting.
  The checkout also has local Craft-integration changes, so do not merge until
  those changes are committed, stashed intentionally, or replayed in a clean
  worktree.

For Hermes upstream updates, prefer a temporary worktree when there are local
integration edits:

```bash
cd ../hermes-agent
git worktree add ../hermes-agent-upstream-sync main
cd ../hermes-agent-upstream-sync
git fetch upstream --prune
git merge --ff-only upstream/main
```

Then reapply or confirm the Craft-specific contract below, run the Python and
Craft test sets, push `origin/main`, and rebuild `apps/electron/resources/vendor/hermes/`.

When syncing Craft upstream, preserve these Craft-side integration points:

| Craft file | Craft-required behavior |
| ---------- | ----------------------- |
| `packages/shared/src/agent/hermes-agent.ts` | Hermes gets both `craft-sources` and `craft-session` MCP endpoints through ACP; source changes do not kill an active stream; model/session changes do not silently drop MCP config. |
| `packages/shared/src/hermes/acp-config.ts` | Bundled runtime env (`CRAFT_HERMES_PYTHON`, `CRAFT_HERMES_ARGS`, `CRAFT_HERMES_HOME`) is treated as one coherent ACP command/config unit. |
| `packages/shared/src/mcp/session-tools-server.ts` | Craft-native tools exposed to Hermes include browser, delegation/session, LLM, auth/config helpers, metadata, and automation; callbacks stay session-scoped. |
| `packages/server-core/src/handlers/rpc/hermes.ts` | Runtime detection, dashboard launch, file/log/skill browsing, and dev-only update controls stay local-only and path-safe under app-scoped `HERMES_HOME`. |
| `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx` | Settings remains an operational Hermes page with compact files/skills views, version line, dashboard launch inside Craft browser, and no giant raw session dump. |
| `apps/electron/scripts/bundle-hermes.*` and `update-hermes-runtime.*` | Bundling installs Hermes with `[web,acp]`, mirrors required source files, validates ACP, and updates only in dev from a clean Hermes checkout. |

The intended runtime model is:

- Hermes config/state is isolated in app-scoped `HERMES_HOME`.
- Hermes Python is isolated in the vendored venv.
- Hermes receives Craft source tools and session tools only through local MCP.
- Hermes must not reuse generic Craft mini-model fallbacks as its own native
  provider/model configuration.
- Packaged apps must not mutate the signed runtime. Dev mode may update and
  rebuild the local bundle.

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
3. `uv pip install <HERMES_SRC>[web,acp]` (non-editable) installs Hermes,
   the web dashboard dependencies, and `agent-client-protocol` into the venv.
   Relocatable: no egg-link with absolute paths.
4. Removes transient `HERMES_SRC/build/` output if the Python install created it.
5. Mirrors a curated subset of Hermes source (`agent/`, `tools/`,
   `acp_adapter/`, `hermes_cli/`, `gateway/`, `plugins/`, `skills/`, etc.)
   into `vendor/hermes/hermes-agent/` for runtime config / skill loading.
6. Applies the Craft ACP streaming compatibility patch to the mirrored
   `acp_adapter/server.py`.
7. Builds/copies `hermes_cli/web_dist` into the mirrored source so the dashboard can run from the packaged app.
8. Downloads platform-specific ripgrep into `vendor/hermes/bin/rg`.
9. Strips `__pycache__`, `*.pyc`, `*.a`, broken symlinks, fake `.app` dirs.
10. Patches `pyvenv.cfg` to `home = ../python/bin` and rewrites venv `bin/`
   symlinks to relative form (codesign rejects absolute or out-of-bundle
   targets).

`HERMES_SRC` defaults to `../../hermes-agent` relative to the repo root.
That checkout should be the fork/upstream checkout described in
`Current contract`, not a detached copy.

### `scripts/bundle-hermes.ps1` (Windows)

Same flow, ScriptBlock-based, uses `Scripts/python.exe` venv layout.

## Source checkout setup

Expected state:

```bash
cd ~/Documents/Projetos/SelfHosting/hermes-agent
git remote -v
# origin   https://github.com/guilhermexp/hermes-agent.git (fetch)
# origin   https://github.com/guilhermexp/hermes-agent.git (push)
# upstream https://github.com/NousResearch/hermes-agent.git (fetch)
# upstream https://github.com/NousResearch/hermes-agent.git (push)
```

If the checkout was cloned directly from NousResearch as `origin`, repoint it:

```bash
cd ~/Documents/Projetos/SelfHosting/hermes-agent
git remote rename origin upstream
git remote add origin https://github.com/guilhermexp/hermes-agent.git
git fetch origin --prune
git fetch upstream --prune
git branch --set-upstream-to=origin/main main
```

To update Hermes safely:

```bash
cd ~/Documents/Projetos/SelfHosting/hermes-agent
git status --short
git fetch upstream main
git merge --ff-only FETCH_HEAD
git push origin main
```

Do not merge with local uncommitted changes in the Hermes checkout. The Craft
update script enforces this because generated files in the Hermes source tree
make upstream sync ambiguous.

## Hermes upstream conflict contract

The Craft fork of Hermes intentionally keeps the delta small, but upstream
updates commonly touch the same areas. When syncing `../hermes-agent`, preserve
behavior, not exact line placement:

| Hermes file | Craft-required behavior |
| ----------- | ----------------------- |
| `acp_adapter/session.py` | `SessionState` keeps the ACP-provided `mcp_servers` list so model switches can rebuild the Python agent without losing Craft MCP endpoints. |
| `acp_adapter/server.py` | ACP `session/set_model` and Hermes `/model` both re-register MCP toolsets after the underlying `AIAgent` is recreated. |
| `tools/mcp_tool.py` | `craft-session` tools keep Craft canonical names such as `mcp__session__browser_tool`; `craft-sources` source tools keep names such as `mcp__github__search_issues`; unrelated external MCP servers keep Hermes' normal `mcp_<server>_<tool>` names. |
| `tests/acp/test_server.py` | Covers MCP tool preservation across ACP and slash-command model switches. |
| `tests/tools/test_mcp_tool.py` | Covers Craft canonical MCP tool naming and normal external MCP naming. |

Do not move Craft tools into a static Hermes `mcp.json` as the primary
integration. Craft session tools are session-scoped and local to the active
Electron app instance, so they must be passed through ACP `session.mcpServers`.
The visible/native behavior comes from the canonical tool names and shared
Craft callback registry, not from a global Hermes config file.

After every Hermes upstream sync, run at minimum:

```bash
cd ../hermes-agent
uv run --extra dev --extra acp python -m pytest \
  tests/acp/test_server.py -k "mcp" \
  tests/tools/test_mcp_tool.py -k "craft or converts_mcp_tool_to_hermes_schema"

cd ../craft-agents-oss
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
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

1. Resolves `HERMES_SRC` / `HERMES_SOURCE_DIR`, defaulting to `../hermes-agent`.
2. Verifies the source has `pyproject.toml`.
3. Refuses to continue if the Hermes checkout has uncommitted changes.
4. Fetches from `HERMES_UPDATE_REMOTE` / `HERMES_UPDATE_BRANCH`, defaulting to
   `upstream/main`.
5. Falls back to `origin/main` only if no `upstream` remote exists.
6. Fast-forwards with `git merge --ff-only FETCH_HEAD`.
7. Rebuilds `apps/electron/resources/vendor/hermes/`.
8. Validates the bundled ACP adapter with `py_compile`.

After the dashboard-triggered update exits, Hermes writes
`$HERMES_HOME/craft-hermes-update-result.json`. Craft watches that marker and
shows an Electron notification asking the user to restart Craft when the update
succeeds, because the running Python runtime was already launched from the old
bundle.

Packaged apps do not receive `CRAFT_HERMES_UPDATE_COMMAND_JSON`. In that mode,
the dashboard update endpoint returns a managed-runtime error and the signed app
bundle must be updated through Craft releases.

## Release/package flow

The Electron distribution commands now rebuild Hermes before packaging:

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

This is required because `apps/electron/resources/vendor/hermes/` is generated.
If packaging skips the bundle step, the app may resolve a stale or missing
runtime.

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

- `hermes:detectInstallation` — reports bundled/system runtime, app-scoped `HERMES_HOME`, discovered providers/models, version, and config paths.
- `hermes:getRuntimeDetails` — extends detection with config/env existence,
  app-scoped logs/skills/sessions paths, source repo path, origin/upstream
  remotes, branch, commit, commit date, release tag, dirty state, available
  providers, and plugin names.
- `hermes:startDashboard` — starts `python -m hermes_cli.main dashboard --no-open` for bundled Hermes (or `hermes dashboard --no-open` for system Hermes), passes Craft embedded update env when applicable, watches the update marker, waits for a free localhost port, then returns the URL.
- `hermes:updateRuntime` — legacy/dev-only helper that runs `apps/electron/scripts/update-hermes-runtime.*`; packaged apps return `unsupported` because signed bundles must be updated via Craft releases. The visible update entry point is the Hermes dashboard.
- `hermes:listLogs` / `hermes:readLog` — enumerate and tail app-scoped Hermes logs.
- `hermes:listHomeFiles` / `hermes:openPath` — browse/reveal files under `HERMES_HOME` only. Secrets (`.env`, `auth.json`, locks) are omitted, path traversal is blocked, and operational directories such as `sessions/`, `logs/`, `skills/`, `memories/`, and `cron/` are shown as collapsed top-level folders so Settings does not render raw session dumps.
- `hermes:listSkills` — lists installed Hermes skills from app-scoped `HERMES_HOME/skills`.

`Settings / AI` remains generic: connections, model defaults, thinking level, workspace overrides.
`Settings / Hermes` is the Hermes-specific operational page: **Abrir Dashboard Hermes**, **Ver logs**, **Files**, **Skills do Hermes**, and **Conectores do Hermes**.
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
| `1d4218be` | `git rev-parse --short HEAD` in `HERMES_SRC` |
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
| `craft-session` | `CraftSessionToolsMcpServer` | Craft-native session tools: plan/auth/config helpers, `call_llm`, `spawn_session`, session metadata tools, `browser_tool`, and `automation_tool`. |

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

Important separation rules:

- No Craft internals are injected into Hermes Python. Hermes only sees MCP.
- `craft-sources` and `craft-session` are local-only `127.0.0.1` endpoints.
- `browser_tool` uses Craft's built-in browser abstraction, not an external OS browser.
- Scheduled-task creation goes through `automation_tool`, which writes Craft `automations.json` and reloads the active `AutomationSystem`; Hermes' native `HERMES_HOME/cron/jobs.json` should remain disabled/hidden in Craft context.

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
- To bump the bundled Hermes commit, update the `hermes-agent` clone next to
  the repo (`HERMES_SRC`) to the desired upstream ref, push the fork, then
  re-run `bun run bundle:hermes`.
- Local dev may run `update-hermes-runtime.*`; packaged apps must be rebuilt
  and released.

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
- `../hermes-agent/tests/acp/test_server.py`
  - Covers ACP MCP registration and verifies `craft-session`-style MCP
    toolsets survive both ACP `session/set_model` and Hermes `/model`.
- `packages/server-core/src/handlers/rpc/hermes.test.ts`
  - `listHomeFiles` omits `.env`.
  - `openPath` blocks traversal outside `HERMES_HOME`.
  - `updateRuntime` returns `unsupported` in packaged apps.
  - `getRuntimeDetails` returns fork/upstream release metadata used by the
    Hermes Settings version row.

Run with:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
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
Hermes Python ACP/MCP tests pass for the Craft-specific fork changes
```

This is not a substitute for the upstream-sync checklist above. If
`../hermes-agent` has new upstream commits or local changes, re-run the Python
and Craft test sets after the sync/replay. Run `bun run typecheck:shared`
whenever TypeScript runtime wiring changes.

## File map

| File                                                                                                | Purpose                                              |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/electron/scripts/bundle-hermes.sh`                                                            | Build vendor/hermes (mac/linux)                      |
| `apps/electron/scripts/bundle-hermes.ps1`                                                           | Build vendor/hermes (windows)                        |
| `apps/electron/scripts/update-hermes-runtime.sh`                                                     | Dev-only upstream fetch + bundle (mac/linux)         |
| `apps/electron/scripts/update-hermes-runtime.ps1`                                                    | Dev-only upstream fetch + bundle (windows)           |
| `apps/electron/scripts/afterPack-hermes.cjs`                                                        | Symlink cleanup + Mach-O signing                     |
| `apps/electron/scripts/afterPack.cjs`                                                               | Chains Liquid Glass icon + afterPack-hermes          |
| `apps/electron/src/main/handlers/hermes-runtime.ts`                                                 | Path resolver + env publisher                        |
| `apps/electron/src/main/index.ts`                                                                   | Calls `publishHermesRuntimeEnv()` on boot            |
| `apps/electron/electron-builder.yml`                                                                | extraResources entry per platform                    |
| `packages/shared/src/hermes/acp-config.ts`                                                          | `normalizeHermesRuntimeConfig`, ACP MCP shape mapper |
| `packages/shared/src/mcp/session-tools-server.ts`                                                   | Local MCP bridge for Craft-native session tools      |
| `packages/shared/src/agent/hermes-agent.ts`                                                         | Streaming-safe lifecycle + Hermes MCP wiring         |
| `packages/server-core/src/handlers/rpc/hermes.ts`                                                    | Runtime detection, dashboard, update, logs, files    |
| `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx`                                  | Hermes Settings operational UI                       |
| `packages/shared/src/hermes/__tests__/acp-config.test.ts`                                           | Resolver/MCP config tests                            |
| `packages/shared/src/mcp/session-tools-server.test.ts`                                              | Craft session tools MCP tests                        |
| `packages/shared/src/agent/__tests__/hermes-agent.test.ts`                                          | Lifecycle tests                                      |
| `packages/server-core/src/handlers/rpc/hermes.test.ts`                                               | Runtime details, path safety, packaged update tests  |

## Quickstart

```bash
# Once: clone your Hermes fork next to craft-agents-oss
git clone https://github.com/guilhermexp/hermes-agent.git \
  ~/Documents/Projetos/SelfHosting/hermes-agent
cd ~/Documents/Projetos/SelfHosting/hermes-agent
git remote add upstream https://github.com/NousResearch/hermes-agent.git
git fetch upstream --prune

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
