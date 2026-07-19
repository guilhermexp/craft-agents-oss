## MODIFIED Requirements

### Requirement: Runtime validation uses the canonical contract
The system SHALL validate session tool inputs and outputs at runtime using the same canonical schemas used to derive TypeScript and MCP JSON Schema definitions, including normalized representations returned by validators.

#### Scenario: Native consumer calls a tool
- **WHEN** a native TypeScript consumer invokes a session tool
- **THEN** the input and returned output are validated against the canonical schema for that tool version

#### Scenario: Validator normalizes tool output
- **WHEN** a session tool validator returns normalized content such as Mermaid source
- **THEN** the handler MUST return the normalized representation under the existing v1 output schema instead of bypassing validation or changing the public contract
