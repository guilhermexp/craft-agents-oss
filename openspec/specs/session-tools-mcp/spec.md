# session-tools-mcp Specification

## Purpose
Expor ferramentas MCP session-scoped que agentes recebem em runtime (browser, sources, config, memory, sandbox, render template, transform data, mermaid validate, etc.), com cada tool recebendo (workspaceId, sessionId) injetado pelo servidor. Garante isolamento entre sessões, sandbox seguro de scripts (FS/path/network) e nomenclatura `mcp__session__*` preservada para consumidores Hermes via ACP.
## Requirements
### Requirement: Tools are session-scoped
The system SHALL execute session MCP tools with backend-injected session context containing the active `workspaceId` and `sessionId`, and tools MUST NOT operate on an arbitrary session outside that context.

#### Scenario: Tool executes with active session context
- **WHEN** an agent calls a session MCP tool
- **THEN** the tool receives the backend-injected workspace and session context for the active session

#### Scenario: Optional session IDs remain controlled
- **WHEN** a tool accepts an optional `sessionId` for metadata, labels, status, messaging, or coordination
- **THEN** the backend-scoped callback controls resolution and authorization instead of trusting unrestricted arbitrary session access

### Requirement: Session MCP server is the entrypoint
The system SHALL expose Craft session tools to MCP consumers through `session-mcp-server` or the Craft session tools MCP bridge, and agents MUST consume them through ACP/MCP transports instead of static global tool wiring.

#### Scenario: Stdio MCP consumer starts session tools
- **WHEN** a subprocess MCP consumer starts `packages/session-mcp-server`
- **THEN** the process exposes the session tools over MCP stdio with the provided session arguments

#### Scenario: Hermes receives session tools through ACP
- **WHEN** Hermes starts or resumes a Craft session
- **THEN** `HermesAgent` passes the per-session `craft-session` MCP endpoint through ACP `session.mcpServers`

### Requirement: Hermes naming is preserved
The system SHALL preserve Craft session tool names under the Hermes consumer prefix `mcp__session__<tool>`.

#### Scenario: Hermes lists Craft session tools
- **WHEN** Hermes receives the `craft-session` MCP server
- **THEN** tools such as `browser_tool`, `spawn_session`, and `call_llm` are available to Hermes as `mcp__session__browser_tool`, `mcp__session__spawn_session`, and `mcp__session__call_llm`

### Requirement: Script sandbox isolates filesystem path and network
The `script_sandbox` tool SHALL isolate filesystem writes to the session workspace, MUST reject path escape attempts including `..` and symlink escapes, and MUST block undeclared outbound network access.

#### Scenario: Input path escapes session directory
- **WHEN** `script_sandbox` receives an input path that resolves outside the active session directory
- **THEN** the tool returns an error tool result and does not execute the script

#### Scenario: Isolation backend is unavailable
- **WHEN** the runtime cannot enforce filesystem or network isolation
- **THEN** `script_sandbox` fails closed with an error tool result

### Requirement: Source test validates before persistence
The `source_test` tool SHALL validate a source connection before accepting persistent source activation or updated connection metadata.

#### Scenario: Source connection fails validation
- **WHEN** `source_test` cannot validate schema, connection, or authentication for a source
- **THEN** it returns an error tool result and does not accept the source as successfully activated

#### Scenario: Source connection passes validation
- **WHEN** `source_test` validates the source successfully and auto-enable is enabled
- **THEN** it may persist test metadata and enable or activate the source for the active session

### Requirement: Memory tools are session-scoped
The `memory_recall` and `memory_store` tools SHALL run only through the active session context and MUST NOT leak memory operations between unrelated sessions.

#### Scenario: Memory feature is disabled
- **WHEN** an agent calls `memory_recall` or `memory_store` without memory callbacks configured for the session
- **THEN** the tool returns an error tool result instead of accessing memory globally

#### Scenario: Memory feature is enabled
- **WHEN** an agent stores or recalls memory
- **THEN** the operation uses the memory callbacks injected for the active session context

### Requirement: Render and transform side effects are constrained
The `render_template` and `transform_data` tools SHALL avoid external side effects and MUST only write declared output artifacts inside the active session data area.

#### Scenario: Render template runs
- **WHEN** `render_template` receives a valid source template and data
- **THEN** it renders the template and writes only the returned HTML artifact in the active session data directory

#### Scenario: Transform output escapes data directory
- **WHEN** `transform_data` receives an output path that resolves outside the session data directory
- **THEN** it returns an error tool result and does not execute the transform

### Requirement: Mermaid is validated before success
The `mermaid_validate` tool SHALL parse Mermaid syntax before returning a successful validation result.

#### Scenario: Mermaid syntax is invalid
- **WHEN** `mermaid_validate` receives invalid Mermaid code
- **THEN** it returns an error tool result with validation details

#### Scenario: Mermaid syntax is valid
- **WHEN** `mermaid_validate` receives valid Mermaid code
- **THEN** it returns a successful tool result indicating the diagram syntax is valid

### Requirement: Tool failures are returned as tool results
Session MCP tools SHALL return failures as structured tool results and MUST NOT expose bare exceptions as the normal error contract.

#### Scenario: Handler catches expected failure
- **WHEN** a handler detects invalid input, unavailable backend capability, or failed validation
- **THEN** it returns a tool result marked as an error with a clear message

#### Scenario: Handler throws unexpectedly
- **WHEN** a session MCP handler throws unexpectedly
- **THEN** the MCP server catches the error and returns an error tool result to the agent

