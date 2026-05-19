# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first — it owns the fork remotes contract and the Hermes integration contract. This file is the orientation map; `AGENTS.md` is the source of truth for fork-sync and Hermes work.

## Runtime

Bun, not Node. All scripts run through Bun (`bun run …`, `bun test`, `bun install`). Workspaces: `packages/*` and `apps/*` (excluding `apps/online-docs`). No `tsc` build step for app code — TypeScript is consumed directly by Bun and esbuild/Vite. `tsc --noEmit` is used only for typechecking.

## Commands

Dev loop:

```bash
bun run electron:dev          # hot-reload desktop app
bun run server:dev            # headless server (CRAFT_DEBUG=true)
bun run webui:dev             # Vite dev for apps/webui (port 5175)
bun run viewer:dev            # Vite dev for apps/viewer
bun run playground:dev        # apps/electron playground (port 5273)
```

Build / package:

```bash
bun run electron:build                # main + preload + renderer + resources + assets
bun run electron:bundle:hermes        # rebuild bundled Hermes runtime (required before electron:dist)
bun run electron:dist[:mac|:win|:linux]
bun run release:mac[:x64]             # signed/notarized DMG via apps/electron/scripts/build-dmg.sh
bun run server:build:{linux,darwin}-{x64,arm64}   # standalone server binary
```

Validation:

```bash
bun test                          # full suite + every *.isolated.ts (must pass each)
bun run typecheck:all             # core, shared, server-core, server, session-tools-core, pi-agent-server, electron, ui
bun run typecheck:shared          # fast inner-loop typecheck
bun run lint                      # ipc-sends + electron + shared + ui (eslint)
bun run lint:i18n:parity          # checks i18n key parity across locales
bun run validate:dev              # typecheck:all + test:shared:all + test:doc-tools
bun run validate:ci               # validate:dev + lint:i18n:parity
```

Single-test patterns:

```bash
bun test path/to/file.test.ts                        # one file
bun test path/to/file.test.ts -t "name pattern"      # one case
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
        packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
        packages/shared/src/mcp/session-tools-server.test.ts \
        packages/shared/src/agent/__tests__/hermes-agent.test.ts \
        packages/server-core/src/handlers/rpc/hermes.test.ts \
        apps/electron/src/transport/__tests__/channel-map-parity.test.ts
# Hermes/Craft integration focus set — see AGENTS.md
```

Notes:
- `bun test` script also runs every `*.isolated.ts` file in its own `bun test` invocation. A single isolated-test failure aborts the whole script — they need their own process for state isolation.
- Doc-tool smoke tests (`test:doc-tools`) require `python3` with the deps under `apps/electron/resources/scripts/`.
- `husky` is wired via `prepare`; commits run staged-only typecheck (`scripts/typecheck-staged.sh`) and i18n staged lint.

## Architecture

Three-tier monorepo: thin clients (Electron / CLI / WebUI / Viewer) → server (`packages/server`) → shared business logic (`packages/shared`).

### Apps

- `apps/electron` — primary desktop GUI. Electron main process spawns the headless server as a subprocess (or connects to a remote one in thin-client mode via `CRAFT_SERVER_URL` + `CRAFT_SERVER_TOKEN`). Renderer is React + Vite + shadcn/ui + Tailwind v4. Build is split: `electron-build-main.ts` / `…-preload.ts` / `…-renderer.ts` / `…-resources.ts`.
- `apps/cli` — WebSocket client to a running server. Self-contained `run` subcommand spawns its own server, executes a prompt, exits. Used for scripting and the 21-step `--validate-server` integration test.
- `apps/webui` and `apps/viewer` — Vite apps. The webui can be served by the server via `CRAFT_WEBUI_DIR=apps/webui/dist` (`server:prod`).

### Packages

- `packages/core` — pure shared types. No runtime deps. Imported everywhere.
- `packages/shared` — agents, sessions, sources, credentials, config, prompts. The bulk of the product logic. Consumed by both server and electron renderer.
- `packages/server-core` — RPC handler implementations (the `handlers/rpc/*.ts` modules). Pure logic, transport-agnostic.
- `packages/server` — WebSocket transport, auth, process bootstrap. Hosts `server-core`.
- `packages/session-mcp-server` and `packages/session-tools-core` — the in-process MCP server and tool implementations exposed to agents (browser, delegation, LLM, automation, metadata, auth/config). Built as a subprocess via `server:build:subprocess`.
- `packages/pi-agent-server` — Pi SDK agent backend (Google AI Studio, ChatGPT Plus Codex, GitHub Copilot, OpenAI). Built as a subprocess.
- `packages/messaging-gateway` and `packages/messaging-whatsapp-worker` — messaging transport plus a WhatsApp worker bundled via `build-wa-worker.ts`.
- `packages/ui` — shared React components.

### Agent backends (Claude, Pi, Hermes)

The `CraftAgent` abstraction routes between three backends depending on the LLM connection:

- **Claude backend** — `@anthropic-ai/claude-agent-sdk`. Handles Anthropic API key, Claude Max/Pro OAuth, and any third-party endpoint surfaced through the “Claude / Anthropic API Key” connection (OpenRouter, Vercel AI Gateway, Ollama, custom).
- **Pi backend** — `@mariozechner/pi-coding-agent` driven by `packages/pi-agent-server`. Handles Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot OAuth, and OpenAI API key.
- **Hermes backend** — embedded NousResearch Hermes runtime consumed as a pinned upstream dependency plus Craft overlay patches (see below). A third backend launched as a subprocess with its own ACP adapter.

When changing agent code, identify which backend(s) are affected — the Pi and Hermes paths each have separate subprocess bundles that must be rebuilt (`server:build:subprocess`, `electron:bundle:hermes`).

### Hermes embedded runtime (read AGENTS.md before touching)

Hermes is a Python agent runtime vendored into the Electron app:

- Bundling scripts: `apps/electron/scripts/bundle-hermes.{sh,ps1}`. Output lands in `apps/electron/resources/vendor/hermes/`.
- Wiring: `packages/shared/src/agent/hermes-agent.ts`, `packages/shared/src/hermes/acp-config.ts`, `packages/shared/src/mcp/session-tools-server.ts`, `packages/server-core/src/handlers/rpc/hermes.ts`, `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx`.
- Hermes source for builds is the pinned cache at `apps/electron/scripts/.hermes-cache/source`; Craft-specific MCP/ACP behavior lives in `apps/electron/scripts/hermes-patches/*.patch`. Keep day-to-day/dashboard updates pinned to a concrete known-good tag/SHA so `git apply --check` sees a reproducible upstream state. Use `upstream/main` only during an explicit Hermes bump/overlay-refresh session, then persist the resolved known-good SHA. Do not switch to `guilhermexp/hermes-agent`, a sibling `../hermes-agent`, or another Craft backend. `HERMES_SRC` is only a short-lived explicit override for active Hermes development and must never become the normal update/bundle path.
- Hermes config/state is app-scoped under `HERMES_HOME` and isolated from standalone `~/.hermes`, the Claude backend, and the Pi backend. Never let user `HERMES_HOME` data leak into the repo. Do not wire Craft-native session tools through a static `mcp.json` — they go through ACP `session.mcpServers` so tools remain per-session instead of becoming global Hermes config.
- Tool naming convention: `craft-session` and `craft-sources` MCP tools keep Craft canonical names (`mcp__session__…`, `mcp__github__…`); external MCP servers keep Hermes-normal names (`mcp_filesystem_read_file`).
- Always rebuild Hermes (`bun run electron:bundle:hermes`) before any `electron:dist*` step.
- Detailed contract: `apps/electron/docs/hermes-embed.md`.

### Configuration & state

User-scoped state at `~/.craft-agent/`: `config.json`, `credentials.enc` (AES-256-GCM), `preferences.json`, `theme.json`, `workspaces/{id}/` (sessions, sources, skills, statuses, automations). Storage migrations live in `packages/shared/src/config` — when changing on-disk shape, add a migration test alongside `storage-migrations.test.ts`.

### IPC / RPC

Renderer ↔ main and client ↔ server share a typed channel map. `bun run lint:ipc-sends` (`scripts/check-raw-sends.sh`) blocks raw `webContents.send` / `ipcRenderer.send` calls. Channel parity is asserted by `apps/electron/src/transport/__tests__/channel-map-parity.test.ts` — keep that test passing when adding channels.

### Sources, skills, automations

- **Sources** — MCP servers (stdio, SSE, HTTP), REST APIs (Google, Slack, Microsoft), and local filesystem/Git/Obsidian. Stored under `workspaces/{id}/sources/`. When spawning stdio MCP servers, the credential filter in `packages/shared` strips sensitive env vars (`ANTHROPIC_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, etc.); use the per-source `env` field to pass anything needed.
- **Skills** — workspace-scoped agent instructions under `workspaces/{id}/skills/`.
- **Automations** — event-driven, schema in `packages/shared/src/.../automations`. Events: `LabelAdd`, `SchedulerTick`, `PreToolUse`, `PostToolUse`, `SessionStart`, etc. Cron actions resolve `$CRAFT_LABEL`, `$CRAFT_SESSION_ID`, and `@source` / `@skill` mentions.

### Internationalization

i18n key parity is enforced (`scripts/check-i18n-parity.ts`). When adding a key in one locale, add it in all. `lint:i18n:staged` runs in pre-commit on staged locale files.

### Spec-driven changes

Non-trivial changes are tracked in `openspec/` (`changes/` for in-flight proposals, `specs/` for frozen specs). Use the `opsx:propose` / `opsx:apply` / `opsx:archive` skills when work follows this flow.

## Conventions specific to this repo

- TypeScript everywhere. New code goes in TS — there is no plain-JS path.
- Tailwind v4 (`@tailwindcss/vite`). No `tailwind.config.ts`. No `@apply`. Theme tokens via `@theme inline`.
- React 18 + Radix UI primitives + shadcn/ui. UI components live in `packages/ui` and `apps/electron/src/renderer`.
- Editor is TipTap 3; markdown rendering uses `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`. Code highlighting via Shiki.
- State: Jotai in renderer; plain modules / event emitters in shared/server.
- Logs: `~/Library/Logs/@craft-agent/electron/main.log` (mac), `%APPDATA%\@craft-agent\electron\logs\main.log` (win), `~/.config/@craft-agent/electron/logs/main.log` (linux). Launch packaged app with `-- --debug` for verbose logging.
- Deep links: `craftagents://…` (handled in main process).

## Fork sync / Hermes pin bumps

Read `AGENTS.md` for the recording protocol before touching Craft upstream or bumping Hermes. Craft upstream sync and Hermes runtime updates are separate: Craft uses normal fork remotes, while Hermes uses `hermes-version.txt` + overlay patches. Keeping `hermes-version.txt` at `upstream/main` is allowed for automatic dev updates, but any upstream drift must be handled by refreshing the overlay patches and validating `git apply --check`. `git fetch upstream --prune` is safe in dirty worktrees; merge / rebase / reset / checkout over local changes are not — only run them when the user explicitly asks.
