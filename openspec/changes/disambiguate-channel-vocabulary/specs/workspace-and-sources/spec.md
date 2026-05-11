## MODIFIED Requirements

### Requirement: Source type discrimination
The system SHALL require every source to declare exactly one discriminated type: `mcp`, `api` or `filesystem`, and service-specific scopes MUST use provider-qualified names when they could collide with product channel vocabulary.

#### Scenario: MCP source config is provided
- **WHEN** a source declares type `mcp`
- **THEN** the source MUST include MCP transport configuration for HTTP/SSE or stdio

#### Scenario: API source config is provided
- **WHEN** a source declares type `api`
- **THEN** the source MUST include API configuration such as base URL, auth type and optional test endpoint

#### Scenario: Filesystem source config is provided
- **WHEN** a source declares type `filesystem`
- **THEN** the source MUST include a filesystem path scoped by the workspace boundary

### Requirement: Slack source scopes are provider-qualified
The system SHALL name Slack channel-related source scopes as Slack-specific scopes and SHALL NOT expose them as generic channel types.

#### Scenario: Slack channel scope is configured
- **WHEN** an API source config selects Slack channel capabilities
- **THEN** the type name identifies the value as a Slack source scope, such as `SlackChannelScope` or `SlackServiceScope`

#### Scenario: Source scope appears in search or imports
- **WHEN** code searches for War Room channels or external messaging channels
- **THEN** Slack source scopes are distinguishable by provider-qualified naming and do not appear as ambiguous generic channel types
