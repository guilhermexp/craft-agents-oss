## ADDED Requirements

### Requirement: Claude config hygiene runs explicitly during startup
Craft SHALL validate and repair Claude CLI configuration through a dedicated Claude config manager during application startup, before instantiating agent drivers or Claude SDK subprocess options.

#### Scenario: Application startup prepares Claude backend runtime
- **WHEN** Craft initializes backend host runtime for available providers
- **THEN** it MUST call the Claude config manager explicitly before any Claude backend instance or SDK subprocess options are created.

#### Scenario: Claude SDK options are built
- **WHEN** Craft builds `@anthropic-ai/claude-agent-sdk` subprocess options
- **THEN** option construction MUST NOT create, delete, rewrite, migrate or validate `~/.claude.json`.

#### Scenario: Claude config contains stale recovery artifacts
- **WHEN** startup validation finds stale `~/.claude.json.backup` or `~/.claude.json.corrupted.*` files that would alter Claude CLI stdout behavior
- **THEN** the Claude config manager MUST handle their cleanup as part of the explicit startup hygiene step.

#### Scenario: Claude config has invalid encoding or content
- **WHEN** startup validation finds a missing file, empty file, BOM-prefixed JSON, BOM-only file or invalid JSON in `~/.claude.json`
- **THEN** the Claude config manager MUST recover the file to a valid JSON state or return a typed validation error.

#### Scenario: Caller needs Claude config contents
- **WHEN** code needs to read the Claude config after startup hygiene
- **THEN** it MUST use the Claude config manager API that returns validated config data or a typed error instead of reading the file through ad hoc parsing.
