## MODIFIED Requirements

### Requirement: Session MCP server is the entrypoint
The system SHALL expose Craft session tools to MCP consumers through `session-mcp-server` or the Craft session tools MCP bridge, and Hermes agents MUST receive the bridge through ACP `session.mcpServers` for every Craft-backed Hermes session instead of relying on static global tool wiring.

#### Scenario: Stdio MCP consumer starts session tools
- **WHEN** a subprocess MCP consumer starts `packages/session-mcp-server`
- **THEN** the process exposes the session tools over MCP stdio with the provided session arguments

#### Scenario: Hermes receives session tools through ACP
- **WHEN** Hermes starts or resumes a Craft session
- **THEN** `HermesAgent` passes the per-session `craft-session` MCP endpoint through ACP `session.mcpServers`
- **AND** the Hermes session can list the Craft session tools without requiring global Hermes `mcp.json` configuration

#### Scenario: Missing session tool bridge is observable
- **WHEN** a Hermes Craft session initializes without the `craft-session` MCP bridge or without listed tools from that bridge
- **THEN** the system reports a diagnostic that identifies the missing Craft MCP bridge instead of silently starting a tool-less Hermes session

### Requirement: Hermes naming is preserved
The system SHALL preserve Craft session tool names under the Hermes consumer prefix `mcp__session__<tool>` and Craft source tool names under `mcp__<source>__<tool>`.

#### Scenario: Hermes lists Craft session tools
- **WHEN** Hermes receives the `craft-session` MCP server
- **THEN** tools such as `browser_tool`, `spawn_session`, and `call_llm` are available to Hermes as `mcp__session__browser_tool`, `mcp__session__spawn_session`, and `mcp__session__call_llm`

#### Scenario: Hermes lists Craft source tools
- **WHEN** Hermes receives a Craft source tool through the `craft-sources` MCP bridge
- **THEN** source tools such as GitHub issue search are available under canonical Craft names such as `mcp__github__search_issues`

#### Scenario: Model switching retains Craft MCP tools
- **WHEN** a Hermes session changes model through ACP `session/set_model` or Hermes `/model`
- **THEN** the `craft-session` and `craft-sources` MCP toolsets remain registered with their canonical names
