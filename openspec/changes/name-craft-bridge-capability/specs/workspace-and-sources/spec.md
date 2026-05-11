## ADDED Requirements

### Requirement: Craft product sources delegate to Craft Bridge

The system SHALL keep sources as the generic connection abstraction while delegating Craft product-specific MCP behavior to the `craft-bridge` capability.

#### Scenario: Craft MCP source is loaded

- **WHEN** a workspace source points to a Craft product MCP endpoint
- **THEN** the source remains listed and enabled through workspace sources, and Craft-specific auth, endpoint validation and document-context semantics are delegated to `craft-bridge`

#### Scenario: Generic source is loaded

- **WHEN** a workspace source points to Slack, GitHub, Google, Microsoft, filesystem or another non-Craft MCP/API provider
- **THEN** the system MUST keep using the generic source behavior and MUST NOT require `craft-bridge`

### Requirement: Craft Agents docs are not workspace document sync

The system MUST NOT treat the always-available `craft-agents-docs` MCP as synced workspace files or as user-owned Craft product documents.

#### Scenario: Built-in docs are available

- **WHEN** `craft-agents-docs` is available to a session
- **THEN** the system exposes it as public setup documentation for Craft Agents, not as workspace file sync
