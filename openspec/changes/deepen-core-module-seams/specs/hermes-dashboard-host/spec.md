## ADDED Requirements

### Requirement: Hermes RPC handlers stay protocol adapters

Os handlers RPC do Hermes SHALL conter apenas tradução de transporte e
delegação. Comportamento de runtime — detecção, ciclo de vida do dashboard,
navegação de logs/arquivos/skills, CRUD de env, watcher de update — SHALL
viver em um módulo de runtime próprio, com `HERMES_HOME` app-scoped
preservado.

#### Scenario: comportamento é testável sem transporte

- **GIVEN** o merge de env do Hermes ou a cadeia de fallback de provider
- **WHEN** o comportamento é testado
- **THEN** é alcançável por chamada de método, sem subprocess, binário temporário ou servidor HTTP
