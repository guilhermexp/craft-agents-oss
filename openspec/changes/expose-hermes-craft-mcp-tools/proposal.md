# Expose Hermes Craft MCP Tools

## Why

Hermes sessions embedded in Craft should receive Craft-native session/source tools through ACP `session.mcpServers`, but the current Hermes session surface can come up without `mcp__session__browser_tool`, `mcp__session__spawn_session`, `mcp__session__call_llm`, or source tools such as `mcp__github__...`. That leaves Hermes isolated from the browser/session/source capabilities that Claude and Pi can use inside Craft.

## What Changes

- Ensure every Hermes Craft session receives the per-session `craft-session` MCP endpoint and active `craft-sources` endpoint through ACP session initialization.
- Preserve canonical Hermes tool names for Craft tools: `mcp__session__<tool>` and `mcp__<source>__<tool>`.
- Add/adjust tests that prove Hermes receives and retains those tools after startup and model switching.
- Add a focused runtime/diagnostic path or log assertion that makes missing Craft MCP tools observable without relying on inference.

## Non-Goals

- Do not create a parallel Hermes plugin that bypasses Craft permissions or session scoping.
- Do not put Craft tools into global Hermes `mcp.json`.
- Do not change public v1 session-tool names, input schemas, or output schemas.
- Do not touch generated Hermes runtime bundles or user `HERMES_HOME` state.
