## MODIFIED Requirements

### Requirement: Backends do not cross-contaminate state
No runtime family SHALL read or write runtime state owned by another runtime family, including when backend SDK APIs evolve during an upstream integration.

#### Scenario: Native runtime is reconciled with upstream SDK APIs
- **WHEN** Claude or Pi adapters adopt an upstream capability, model or token-refresh API
- **THEN** the implementation MUST preserve provider-specific state and MUST NOT import Hermes config, fallback, dashboard state, `HERMES_HOME` data or ACP tool registry state

#### Scenario: Hermes embedded integration is active
- **WHEN** a Hermes session starts or changes model
- **THEN** it MUST NOT reuse Claude SDK state, Pi SDK state, Pi model registry or Pi auth storage
