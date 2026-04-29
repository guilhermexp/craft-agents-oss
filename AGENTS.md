# Craft Agents OSS - Development Notes

This repo is a Craft fork. Treat upstream sync and Hermes integration as
separate concerns.

## Fork remotes

- Craft fork:
  - local repo: `craft-agents-oss`
  - `origin`: `https://github.com/guilhermexp/craft-agents-oss.git`
  - `upstream`: `https://github.com/lukilabs/craft-agents-oss.git`
- Hermes fork consumed by Craft:
  - local repo: `../hermes-agent`
  - `origin`: `https://github.com/guilhermexp/hermes-agent.git`
  - `upstream`: `https://github.com/NousResearch/hermes-agent.git`

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
- Hermes fork files under `../hermes-agent/acp_adapter/` or
  `../hermes-agent/tools/mcp_tool.py`.

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

When syncing Hermes upstream, preserve these fork behaviors:

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
  dashboard launch, logs/files/skills browsing, and dev-only update path-safe
  under app-scoped `HERMES_HOME`.
- `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx` keeps the
  Hermes operational UI compact and avoids raw giant session/skill dumps.

## Validation

For Hermes/Craft integration changes, run the focused Craft tests:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

For Hermes fork changes, run from `../hermes-agent`:

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

There is no repo-local `CLAUDE.md`. The parent `../CLAUDE.md` is SelfHosting
infra-oriented and contains environment-specific server notes, so keep
Craft/Hermes fork instructions in this repo-local `AGENTS.md` and
`apps/electron/docs/hermes-embed.md`.
