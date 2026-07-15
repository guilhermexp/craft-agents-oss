# agent-backends Specification

## Purpose
Definir o contrato dos três backends de agente (Claude via Anthropic SDK, Pi via subprocess `pi-agent-server`, Hermes via ACP/Python embutido) e a factory que os instancia conforme a config da sessão. Garante isolamento mútuo (sem cross-contamination de estado, registry ou tools), credenciais centralizadas em `packages/shared/src/auth` sem logs sensíveis, e computer-use exclusivo do Pi.
## Requirements
### Requirement: Factory selects backend from session provider
The system SHALL classify the resolved session provider into either a native agent runtime or an external embedded integration before instantiating any backend.

#### Scenario: Session declares Anthropic provider
- **WHEN** a session resolves to an LLM connection with provider type `anthropic`
- **THEN** the backend boundary MUST route the session to the native agent runtime.

#### Scenario: Session declares Pi provider
- **WHEN** a session resolves to an LLM connection with provider type `pi` or `pi_compat`
- **THEN** the backend boundary MUST route the session to the native agent runtime.

#### Scenario: Session declares Hermes provider
- **WHEN** a session resolves to an LLM connection with provider type `hermes`
- **THEN** the backend boundary MUST route the session to the Hermes embedded integration instead of the native agent runtime.

### Requirement: Backends do not cross-contaminate state
No runtime family SHALL read or write runtime state owned by another runtime family.

#### Scenario: Native runtime is active
- **WHEN** a Claude or Pi session starts or changes model
- **THEN** it MUST NOT reuse Hermes config, Hermes model fallback, Hermes dashboard state, `HERMES_HOME` data or Hermes ACP tool registry state.

#### Scenario: Hermes embedded integration is active
- **WHEN** a Hermes session starts or changes model
- **THEN** it MUST NOT reuse Claude SDK state, Pi SDK state, Pi model registry or Pi auth storage.

### Requirement: Credentials stay in shared auth storage and are never logged
API keys and OAuth tokens SHALL be stored and retrieved through shared credential management, and MUST NOT be logged.

#### Scenario: Native runtime needs credentials
- **WHEN** Claude or Pi needs an API key or OAuth token
- **THEN** the native runtime MUST retrieve the credential through the shared credential layer before injecting it into the active native backend.

#### Scenario: Hermes integration needs bridged credentials
- **WHEN** Hermes needs Craft-provided credentials
- **THEN** the Hermes embedded integration MUST bridge only the scoped credentials required for the active Hermes subprocess or dashboard.

#### Scenario: Runtime writes debug output
- **WHEN** any runtime logs auth, spawn, validation or model discovery diagnostics
- **THEN** the log MUST NOT include raw API keys, OAuth access tokens, OAuth refresh tokens or bearer tokens.

### Requirement: Authentication failures return discriminated errors
Authentication failures SHALL be surfaced as discriminated backend/auth results rather than bare exceptions.

#### Scenario: Native auth fails during backend post initialization
- **WHEN** credentials are missing, expired or invalid during Claude or Pi initialization
- **THEN** the native runtime MUST return a structured `PostInitResult` warning or equivalent discriminated result that the renderer can use to request re-login.

#### Scenario: Hermes auth bridge fails
- **WHEN** Hermes credential bridging fails for the active subprocess or dashboard
- **THEN** the Hermes embedded integration MUST surface a typed auth-required or bridge failure result instead of only throwing an unclassified exception.

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

### Requirement: Hermes provider recovers from subprocess death

O backend Hermes SHALL detectar a morte do subprocess ACP (exit do
`agentProcess` ou erro de I/O do pipe durante o streaming) e descartar o
provider stale, de modo que o próximo turno respawne um subprocess limpo sem
reiniciar o app. Erros de negócio (ex.: rate-limit da API) SHALL NOT derrubar
o provider.

#### Scenario: subprocess morre entre turnos

- **GIVEN** uma sessão Hermes com provider ativo e nenhum turno em andamento
- **WHEN** o subprocess Python morre (exit observado)
- **THEN** o provider stale é limpo (`cleanup` provider-level) e zerado
- **AND** o próximo turno cria um provider novo em vez de escrever num pipe morto

#### Scenario: subprocess morre no meio de um turno

- **GIVEN** uma sessão Hermes com um turno em streaming
- **WHEN** o subprocess morre ou o streaming falha com erro de I/O do pipe
- **THEN** o turno termina com evento de erro para o usuário
- **AND** o provider é resetado ao final do turno (`pendingProviderRestart`)
- **AND** o turno seguinte respawna um subprocess limpo

#### Scenario: erro de negócio não reseta o provider

- **GIVEN** uma sessão Hermes com um turno em streaming
- **WHEN** o streaming falha com um erro que não é de I/O do subprocess (ex.: rate-limit)
- **THEN** o provider existente é mantido para o próximo turno

