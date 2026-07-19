## MODIFIED Requirements

### Requirement: Native runtime exposes a single spawn entry point
O sistema SHALL esconder factory, driver pool, discovery de capability, resolução de modelo, refresh de credenciais e computer-use nativos atrás de APIs públicas coerentes entre seus adapters.

#### Scenario: Consumer starts native session
- **WHEN** um consumer precisa iniciar uma sessão Claude ou Pi
- **THEN** ele MUST chamar o ponto de entrada público do runtime nativo em vez de escolher drivers diretamente

#### Scenario: Upstream capability APIs change
- **WHEN** uma atualização upstream adiciona capability discovery, token refresh ou browser-tool gating aos drivers nativos
- **THEN** os adapters Claude e Pi MUST implementar o mesmo contrato interno sem expor branching de provider aos consumers
