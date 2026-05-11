# Craft Bridge

`craft-bridge` owns integration with the Craft product through Craft MCP
endpoints (`https://mcp.craft.do/links/{id}/mcp`).

It covers:

- Craft product MCP endpoint classification and validation.
- Craft MCP OAuth adaptation over the generic MCP OAuth primitives.
- Explicit document-context contracts for sessions and War Room channels.

It does not cover:

- `craft-agents-docs`, which is public Craft Agents documentation exposed as an
  always-available MCP server.
- Generic MCP sources from other providers.
- Slack, WhatsApp, Google, Microsoft, GitHub, filesystem, meeting, or unrelated
  workspace context.

Authenticated Craft product MCP sources may expose user-authorized documents,
blocks, collections, search, and tasks as Craft context. When no authenticated
Craft product MCP source is present, callers must report Craft context as
unavailable instead of falling back to app docs, branding, or workspace files.
