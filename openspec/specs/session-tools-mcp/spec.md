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

### Requirement: Session tools expose a versioned frontier API
The system SHALL treat `session-tools-mcp` as a versioned frontier API shared by native TypeScript consumers and Hermes ACP/MCP consumers.

#### Scenario: Existing tools are exposed as v1
- **WHEN** the system exposes an existing session tool to native agents or Hermes
- **THEN** the tool is associated with API version `v1` and preserves its existing public name, including the Hermes `mcp__session__<tool>` consumer name

#### Scenario: Breaking contract change is introduced
- **WHEN** a tool changes its public name, required input, output shape, or documented error contract incompatibly
- **THEN** the change is introduced under a new major API version instead of mutating the active `v1` contract in place

### Requirement: Tool schemas are explicit and canonical
Every session tool exposed through `session-tools-mcp` SHALL declare explicit canonical input and output schemas before it is available to native or ACP/MCP consumers.

#### Scenario: Tool is registered
- **WHEN** a session tool is added to the canonical registry
- **THEN** the registry entry includes the tool name, API version, input schema, output schema, description, exposure mode, and handler ownership

#### Scenario: Tool lacks output schema
- **WHEN** a tool does not declare an explicit output schema
- **THEN** the tool is not exposed through the native registry or the session MCP server

### Requirement: Runtime validation uses the canonical contract
The system SHALL validate session tool inputs and outputs at runtime using the same canonical schemas used to derive TypeScript and MCP JSON Schema definitions.

#### Scenario: Native consumer calls a tool
- **WHEN** a native TypeScript consumer invokes a session tool
- **THEN** the input and returned output are validated against the canonical schema for that tool version

#### Scenario: Hermes calls a tool through ACP MCP
- **WHEN** Hermes invokes a session tool received through ACP `session.mcpServers`
- **THEN** the session MCP bridge validates the input and returned output against the canonical schema for that tool version

### Requirement: Native and ACP MCP catalogs are validated in CI
The system SHALL include a CI contract check that compares the native session tool catalog with the catalog exposed through the ACP/MCP bridge used by Hermes.

#### Scenario: Catalogs match
- **WHEN** CI extracts the native catalog and lists tools from the session MCP bridge
- **THEN** each exposed tool has matching name, API version, input schema, output schema, and exposure metadata

#### Scenario: Catalogs diverge
- **WHEN** a tool exists only in the native catalog, exists only in the ACP/MCP catalog, or has a different schema between catalogs
- **THEN** the CI contract check fails before the change can be merged

### Requirement: New tools require contract approval before exposure
The system SHALL block new session tools from being exposed unless they pass an approval gate for frontier API contract completeness.

#### Scenario: Pull request adds a new tool
- **WHEN** a pull request adds or exposes a new session tool
- **THEN** the approval gate verifies the tool uses the canonical registration entry point, declares its API version, declares input and output schemas, and is covered by native and ACP/MCP contract tests

#### Scenario: Pull request bypasses canonical registration
- **WHEN** a pull request exposes a session tool outside the canonical registration entry point
- **THEN** the approval gate fails and reports that the tool must be registered through the frontier API contract

