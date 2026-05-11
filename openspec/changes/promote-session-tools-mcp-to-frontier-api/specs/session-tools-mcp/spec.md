## ADDED Requirements

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
