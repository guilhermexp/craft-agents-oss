## ADDED Requirements

### Requirement: Hermes is an external embedded integration
O sistema SHALL tratar Hermes como sistema externo embedded via ACP/MCP, não como peer nativo da factory Claude/Pi.

#### Scenario: Native runtime is initialized
- **WHEN** o runtime nativo Claude/Pi é inicializado
- **THEN** ele MUST NOT registrar driver Hermes, normalizar config Hermes, resolver dashboard Hermes ou tocar `HERMES_HOME`.

#### Scenario: Hermes session starts
- **WHEN** uma sessão Hermes é iniciada
- **THEN** ela MUST usar o caminho `hermes-embed` com `HermesAgent`, `acp-config.ts`, auth bridge Hermes e `session.mcpServers` ACP.

#### Scenario: Hermes dashboard starts
- **WHEN** o dashboard Hermes é iniciado pelo Craft
- **THEN** ele MUST usar configuração, ambiente e paths do contrato Hermes embedded, sem depender da factory nativa Claude/Pi.
