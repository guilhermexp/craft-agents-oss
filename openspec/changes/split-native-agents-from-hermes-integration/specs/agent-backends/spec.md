## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Claude backend uses official SDK and custom endpoint configuration
**Reason**: Claude implementation details now belong to the `native-agent-runtime` capability.
**Migration**: Use `native-agent-runtime` requirements for Claude SDK spawn, custom endpoint handling and credential routing.

### Requirement: Pi backend runs through managed subprocess
**Reason**: Pi implementation details now belong to the `native-agent-runtime` capability.
**Migration**: Use `native-agent-runtime` requirements for Pi subprocess spawn, credential init and runtime capability handling.

### Requirement: Hermes backend uses ACP runtime with app-scoped home
**Reason**: Hermes implementation details belong to `hermes-embed`; Hermes is not a peer native backend.
**Migration**: Use `hermes-embed` requirements for ACP runtime config, app-scoped `HERMES_HOME`, dashboard and packaged runtime behavior.

### Requirement: Model selection is session-scoped
**Reason**: Model selection behavior splits by runtime family: Claude/Pi model resolution belongs to `native-agent-runtime`, and Hermes model behavior belongs to `hermes-embed`.
**Migration**: Use `native-agent-runtime` for native model resolution and `hermes-embed` for Hermes config/model preservation.

### Requirement: Computer-use is Pi-only
**Reason**: Computer-use is a Pi-native capability and no longer belongs in the broad `agent-backends` boundary spec.
**Migration**: Use `native-agent-runtime` for Pi-only computer-use requirements.
