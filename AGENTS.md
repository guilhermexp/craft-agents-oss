# Craft Agents OSS - Development Notes

This repo is a Craft fork. Treat Craft upstream sync and Hermes runtime
updates as separate concerns. Hermes is consumed as a pinned upstream
dependency plus Craft overlay patches, not as a hand-merged sibling fork.

## Upstream inputs

- Craft fork:
  - local repo: `craft-agents-oss`
  - `origin`: `https://github.com/guilhermexp/craft-agents-oss.git`
  - `upstream`: `https://github.com/lukilabs/craft-agents-oss.git`
- Hermes upstream consumed by Craft:
  - primary source: pinned `NousResearch/hermes-agent` clone under
    `apps/electron/scripts/.hermes-cache/source` (gitignored, build-owned)
  - pin file: `apps/electron/scripts/hermes-version.txt`
  - Craft overlay patches: `apps/electron/scripts/hermes-patches/*.patch`
  - no user fork is part of the normal flow. Do not use
    `guilhermexp/hermes-agent` or a sibling `../hermes-agent` checkout as an
    implicit source.
  - explicit dev override only: `HERMES_SRC=/path/to/hermes-agent` skips the
    cache and patch overlay for short-lived active Hermes development. It must
    never be the default update/bundle path.

`git fetch upstream --prune` is safe in dirty worktrees. Do not merge,
fast-forward, rebase, reset, or checkout over local changes unless the user
explicitly asks for that operation.

Before any fork sync decision, record:

```bash
git status --short
git fetch upstream --prune
git rev-list --left-right --count HEAD...upstream/main
git log --oneline HEAD..upstream/main -n 20
git log --oneline upstream/main..HEAD -n 20
```

## Hermes embedded runtime

The integration contract is documented in
`apps/electron/docs/hermes-embed.md`. Update that document whenever changing:

- Hermes runtime bundling scripts.
- `packages/shared/src/agent/hermes-agent.ts`.
- `packages/shared/src/hermes/acp-config.ts`.
- `packages/shared/src/mcp/session-tools-server.ts`.
- Hermes overlay patches under `apps/electron/scripts/hermes-patches/`.

Hermes must stay isolated from other Craft agents:

- Hermes config/state lives under app-scoped `HERMES_HOME`.
- The vendored Python runtime is generated under
  `apps/electron/resources/vendor/hermes/`.
- Do not commit Hermes sessions, logs, generated runtime state, or user
  `HERMES_HOME` data to the repo.
- Do not wire Craft-native session tools through a static Hermes `mcp.json` as
  the primary path. Craft passes session-scoped MCP endpoints through ACP
  `session.mcpServers`.

Craft-native Hermes tools must keep Craft canonical names:

- `craft-session` tools: `mcp__session__browser_tool`,
  `mcp__session__spawn_session`, `mcp__session__call_llm`, etc.
- `craft-sources` tools: source names such as `mcp__github__search_issues`.
- External/non-Craft MCP servers keep Hermes normal names such as
  `mcp_filesystem_read_file`.

When bumping the Hermes upstream pin, preserve these overlay behaviors:

- `acp_adapter/session.py` stores ACP-provided `mcp_servers` on session state.
- `acp_adapter/server.py` re-registers MCP toolsets after ACP
  `session/set_model` and Hermes `/model`.
- `tools/mcp_tool.py` special-cases Craft MCP naming while preserving normal
  Hermes MCP naming for external servers.

When syncing Craft upstream, preserve these Craft-side integration points:

- `packages/shared/src/agent/hermes-agent.ts` passes both `craft-sources` and
  `craft-session` MCP endpoints to Hermes through ACP.
- `packages/shared/src/hermes/acp-config.ts` keeps bundled Hermes command,
  args, env, and app-scoped `HERMES_HOME` coherent.
- `packages/shared/src/mcp/session-tools-server.ts` keeps browser,
  delegation/session, LLM, auth/config, metadata, and automation tools
  session-scoped.
- `packages/server-core/src/handlers/rpc/hermes.ts` keeps runtime detection,
  dashboard launch, logs/files/skills browsing, dashboard-delegated dev
  update, and update-completion notification path-safe under app-scoped
  `HERMES_HOME`.
- `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx` keeps the
  Hermes operational UI compact, launches the Hermes dashboard, and avoids raw
  giant session/skill dumps. Settings must not duplicate the dashboard's native
  update action.

## Validation

For Hermes/Craft integration changes, run the focused Craft tests:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

For Hermes overlay changes, run against the patched Hermes source used for the
bundle. If you are iterating with `HERMES_SRC`, run from that checkout;
otherwise run from `apps/electron/scripts/.hermes-cache/source` after the
patches have been applied by `bundle-hermes.*`:

```bash
uv run --extra dev --extra acp python -m pytest \
  tests/acp/test_server.py -k "mcp" \
  tests/tools/test_mcp_tool.py -k "craft or converts_mcp_tool_to_hermes_schema"
```

When packaging or validating release behavior, rebuild Hermes before the
Electron distribution step:

```bash
cd apps/electron
bun run bundle:hermes
```

## CLAUDE.md / AGENTS.md scope

There is a repo-local `CLAUDE.md`, but `AGENTS.md` remains the source of truth
for Craft fork-sync and Hermes integration contracts. The parent `../CLAUDE.md`
is SelfHosting infra-oriented and contains environment-specific server notes,
so keep Craft/Hermes integration instructions in this repo-local `AGENTS.md`
and `apps/electron/docs/hermes-embed.md`.
