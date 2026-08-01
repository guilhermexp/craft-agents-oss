## ADDED Requirements

### Requirement: Session frontier exposes one generic workspace-object data plane

O frontier versionado SHALL expor uma tool genérica com actions validadas para
schema, entries, saved views, query e projection repair. A tool MUST usar o
service compartilhado, MUST limitar strings de value a 64.000 caracteres,
MUST ser registrada por `defineTool(...)` com `apiVersion: v1` e schemas Zod
explícitos de input/output, e MUST NOT aceitar SQL cru ou verbs específicos de
renderer. Cada mutation aceita no máximo 200 entries/IDs; list aceita no máximo
200 objects; cada object read retorna no máximo 200 entries; strings de value e
de output permanecem limitadas a 64.000 caracteres.

#### Scenario: Agente cria CRM sem tool de UI

- **WHEN** um backend compatível cria schema e entries pela tool genérica
- **THEN** a resposta contém object ID, revision e projection status sem SQL ou renderer verb
- **Test:** `integration`

#### Scenario: Mutation contém value inválido

- **WHEN** a tool recebe um value incompatível com o field type
- **THEN** ela retorna erro validado e não publica revisão de sucesso
- **Test:** `unit`

#### Scenario: Registry e MCP executam a mesma action

- **WHEN** a mesma mutation é chamada pelo registry e pelo session MCP
- **THEN** ambos usam o mesmo handler e response envelope
- **Test:** `integration`

### Requirement: Structured-object guidance is contextual and capability-aware

O runtime SHALL adicionar orientação compacta somente quando o workspace possui
object store e o backend hospeda a tool. Sessões incompatíveis ou workspaces sem
objetos MUST NOT receber instruções que afirmem capability ausente.

#### Scenario: Workspace estruturado usa backend compatível

- **WHEN** a sessão é criada
- **THEN** o prompt recebe o contrato compacto de create, relate, project e verify
- **Test:** `integration`

#### Scenario: Backend não hospeda a tool

- **WHEN** a sessão inicia em backend incompatível
- **THEN** a orientação de objetos não é injetada
- **Test:** `unit`

### Requirement: Source readiness includes a backend-visible tool probe

Uma source SHALL ser considerada pronta para agentes somente após source test e
probe em sessão compatível confirmarem as tools esperadas. O probe MUST NOT
retornar credentials, tokens ou headers secretos.
O contrato da source MUST declarar `expectedTools` como pares
`{ name, apiVersion }`. Sucesso do probe é um envelope redacted
`{ ready: true, observedTools }` que contém todos os pares esperados com versões
compatíveis; ausência ou versão incompatível mantém a source unhealthy.

#### Scenario: OAuth funciona mas tool probe falha

- **WHEN** source test passa e o backend não observa a tool esperada
- **THEN** a source permanece unhealthy com erro acionável
- **Test:** `integration`

#### Scenario: Probe conclui

- **WHEN** source test e tool probe passam
- **THEN** a source fica ready e a evidência não contém secrets
- **Test:** `integration`
