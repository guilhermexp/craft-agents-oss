## 1. Contract and discovery

- [x] 1.1 Trace the Hermes ACP session startup path and confirm why `craft-session`/`craft-sources` are not visible in the current Hermes session tool surface.
- [x] 1.2 Confirm the fix does not touch unrelated dirty renderer files already present in the worktree.

## 2. Implementation

- [x] 2.1 Fix the Craft/Hermes MCP wiring so each Hermes session receives `craft-session` and active `craft-sources` via ACP `session.mcpServers`.
- [x] 2.2 Preserve canonical tool names (`mcp__session__...`, `mcp__github__...`) and reapply MCP toolsets after Hermes model/session changes.
- [x] 2.3 Add a focused observable diagnostic/test for missing Craft MCP tools.

## 3. Validation

- [x] 3.1 Run `openspec validate expose-hermes-craft-mcp-tools --strict --no-interactive`.
- [x] 3.2 Run focused tests: `bun test packages/shared/src/hermes/__tests__/acp-config.test.ts packages/shared/src/mcp/session-tools-server.test.ts packages/shared/src/agent/__tests__/hermes-agent.test.ts`.
- [x] 3.3 If session-tool contracts changed, run `bun run lint:tool-contracts`.
- [ ] 3.4 Validate in a real Hermes-backed Craft session that `tools/list` exposes `mcp__session__browser_tool`, `mcp__session__spawn_session`, and `mcp__session__call_llm`, then call at least one benign tool.
