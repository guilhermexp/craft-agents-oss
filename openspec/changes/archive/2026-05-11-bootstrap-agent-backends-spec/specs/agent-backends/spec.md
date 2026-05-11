## ADDED Requirements

### Requirement: Factory selects backend from session provider
The system SHALL instantiate the agent backend from the provider type declared by the resolved session LLM connection.

#### Scenario: Session declares Anthropic provider
- **WHEN** a session resolves to an LLM connection with provider type `anthropic`
- **THEN** the backend factory MUST instantiate the Claude backend.

#### Scenario: Session declares Pi provider
- **WHEN** a session resolves to an LLM connection with provider type `pi` or `pi_compat`
- **THEN** the backend factory MUST instantiate the Pi backend.

#### Scenario: Session declares Hermes provider
- **WHEN** a session resolves to an LLM connection with provider type `hermes`
- **THEN** the backend factory MUST instantiate the Hermes backend.

### Requirement: Claude backend uses official SDK and custom endpoint configuration
The Claude backend SHALL use the official `@anthropic-ai/claude-agent-sdk` and MUST respect a configured custom Anthropic-compatible endpoint.

#### Scenario: Claude starts with API key
- **WHEN** the selected Claude connection uses API key authentication
- **THEN** the backend MUST inject the Anthropic API key for the Claude SDK subprocess before the first chat turn.

#### Scenario: Claude starts with OAuth
- **WHEN** the selected Claude connection uses Anthropic OAuth
- **THEN** the backend MUST retrieve or refresh the OAuth token through shared auth state before the Claude SDK subprocess starts.

#### Scenario: Claude starts with custom endpoint
- **WHEN** the selected Claude connection configures a base URL
- **THEN** the backend MUST pass the custom endpoint to the Claude SDK subprocess instead of silently using the default Anthropic endpoint.

### Requirement: Pi backend runs through managed subprocess
The Pi backend SHALL run through a subprocess managed by `packages/pi-agent-server`.

#### Scenario: Pi session starts
- **WHEN** the Pi backend receives its first chat, mini completion or LLM query request
- **THEN** the main process MUST spawn the Pi agent server and initialize it over the JSONL protocol.

#### Scenario: Pi server receives credentials
- **WHEN** the Pi subprocess receives its init message
- **THEN** it MUST populate an in-memory Pi auth storage with the provider-specific credential supplied by the main process.

#### Scenario: Pi OAuth token refreshes
- **WHEN** a Pi OAuth credential is refreshed during a running session
- **THEN** the main process MUST send a `token_update` message so the subprocess updates its in-memory auth storage.

### Requirement: Hermes backend uses ACP runtime with app-scoped home
The Hermes backend SHALL be instantiated from `acp-config.ts` and MUST run with app-scoped `HERMES_HOME`.

#### Scenario: Hermes provider starts
- **WHEN** the Hermes backend creates its ACP provider
- **THEN** it MUST use the normalized Hermes runtime command, args, config path and environment from `acp-config.ts`.

#### Scenario: Hermes profile is active
- **WHEN** a Hermes session or active Hermes profile is configured
- **THEN** the backend MUST derive the runtime home/config/env paths from that profile under the app-scoped Hermes home.

#### Scenario: Packaged Hermes runtime is required
- **WHEN** the packaged app requires the bundled Hermes runtime
- **THEN** the backend MUST fail closed if the vendored runtime command is missing instead of falling back to a standalone user `hermes` binary.

### Requirement: Backends do not cross-contaminate state
No backend SHALL read or write runtime state owned by another backend.

#### Scenario: Claude backend is active
- **WHEN** a Claude session starts or changes model
- **THEN** it MUST NOT reuse Pi model registry, Pi auth storage, Hermes config, Hermes model fallback or Hermes tool registry state.

#### Scenario: Pi backend is active
- **WHEN** a Pi session starts or changes model
- **THEN** it MUST NOT reuse Claude SDK session state, Claude OAuth env state beyond explicitly injected credentials, Hermes config, Hermes model fallback or Hermes tool registry state.

#### Scenario: Hermes backend is active
- **WHEN** a Hermes session starts or changes model
- **THEN** it MUST NOT reuse Claude SDK state, Pi SDK state, Pi model registry or Pi auth storage.

### Requirement: Credentials stay in shared auth storage and are never logged
API keys and OAuth tokens SHALL be stored and retrieved through `packages/shared/src/auth` and shared credential management, and MUST NOT be logged.

#### Scenario: Backend needs credentials
- **WHEN** any backend needs an API key or OAuth token
- **THEN** it MUST retrieve the credential through the shared auth/credential layer before injecting it into the active backend runtime.

#### Scenario: Backend writes debug output
- **WHEN** a backend logs auth, spawn, validation or model discovery diagnostics
- **THEN** the log MUST NOT include raw API keys, OAuth access tokens, OAuth refresh tokens or bearer tokens.

### Requirement: Authentication failures return discriminated errors
Authentication failures SHALL be surfaced as discriminated backend/auth results rather than bare exceptions.

#### Scenario: Auth fails during backend post initialization
- **WHEN** credentials are missing, expired or invalid during backend initialization
- **THEN** the backend MUST return a structured `PostInitResult` warning or equivalent discriminated result that the renderer can use to request re-login.

#### Scenario: Auth fails during a turn
- **WHEN** a backend detects an authentication failure while streaming
- **THEN** it MUST emit a typed error or auth-required callback instead of only throwing an unclassified exception.

### Requirement: Model selection is session-scoped
Model selection SHALL be scoped to the active session and MUST preserve custom provider models configured for Hermes Messengers.

#### Scenario: Session selects a model
- **WHEN** a session is created or changes model
- **THEN** the selected model MUST apply to that session backend without changing unrelated sessions globally.

#### Scenario: Hermes custom provider models exist
- **WHEN** Hermes Messengers settings contain custom provider models
- **THEN** backend model discovery and selection MUST preserve those models rather than replacing them with generic defaults.

### Requirement: Computer-use is Pi-only
The system SHALL expose `computer-use` tools only to the Pi backend.

#### Scenario: Pi runs on supported desktop platform
- **WHEN** the Pi backend starts in a non-headless macOS session and the `pi-computer-use` package is available
- **THEN** the Pi subprocess MAY add the computer-use tool names to its allowlist.

#### Scenario: Claude backend starts
- **WHEN** the Claude backend starts
- **THEN** it MUST NOT receive the Pi `computer-use` tool package or Pi computer-use allowlist entries.

#### Scenario: Hermes backend starts
- **WHEN** the Hermes backend starts
- **THEN** it MUST NOT receive the Pi `computer-use` tool package or Pi computer-use allowlist entries.
