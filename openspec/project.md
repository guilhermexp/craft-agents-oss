# Project Context

## Purpose

Craft Agents OSS is an Electron desktop app for agent-assisted work inside Craft-like documents and local workspaces: it combines a Claude Code-like chat experience, session-scoped tools, document/source context, and embedded agent runtimes including Hermes for Python/ACP-backed workflows.

## Tech Stack

- Bun 1.3.x is the JavaScript runtime and package manager for the monorepo.
- TypeScript is used across `packages/*` and `apps/*`, with React 18 for renderer UI.
- Electron 41 powers the desktop shell; Vite builds renderer apps; esbuild bundles Electron main/preload entrypoints.
- electron-builder packages desktop releases for macOS, Windows, and Linux.
- Python is used for document-tool smoke tests and the embedded Hermes runtime.
- Hermes is bundled under `apps/electron/resources/vendor/hermes/` from a pinned upstream source plus Craft overlay patches.
- Subprocess integrations include the WhatsApp worker, Codex CLI, Copilot CLI, Pi runtime, and session MCP servers.

## Conventions

- Use Bun scripts from the repository root unless a package-specific command is required.
- Keep workspaces under `packages/*` and `apps/*`; `apps/online-docs` is excluded from Bun workspaces.
- Prefer direct module imports. Do not introduce barrel-file imports.
- Keep TypeScript strict and avoid `any`; use Zod for explicit runtime schemas where contracts cross boundaries.
- Use named exports and kebab-case filenames for new source files.
- Keep Electron, Hermes, session-tool, and channel contracts documented in `AGENTS.md` and the related docs named there.
- Preserve i18n parity by running `bun run lint:i18n:parity` as part of CI validation.
- Do not touch generated Hermes runtime state, app-scoped `HERMES_HOME` data, sessions, or logs.

## Commands

- `bun run electron:dev` - start the Electron desktop development flow.
- `bun run validate:ci` - run typechecks, focused shared/config/doc-tool tests, and i18n parity.
- `bun run typecheck` - run the default shared package TypeScript check.
- `bun run lint` - run IPC send checks plus Electron, shared, and UI ESLint checks.
- `bun run electron:dist:mac` - bundle Hermes, build Electron assets, and package macOS with electron-builder.
- `bun run electron:dist:win` - bundle Hermes for Windows, build Electron assets, and package Windows with electron-builder.
- `bun run electron:dist:linux` - bundle Hermes, build Electron assets, and package Linux with electron-builder.
- `bash scripts/release-mac.sh [arm64|x64]` - build the macOS release artifact for the selected architecture.
