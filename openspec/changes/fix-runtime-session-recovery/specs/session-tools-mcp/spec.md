## ADDED Requirements

### Requirement: Browser element refs are invalidated by navigation

Refs `@eN` do snapshot de acessibilidade SHALL ser válidas apenas dentro do
documento em que foram capturadas. Navegação (`did-navigate`) e navegação
in-page (`did-navigate-in-page`) SHALL invalidar todas as refs correntes
(incluindo o mapa estável `backendNodeId → ref`). Ações (`click`/`fill`/
`select`) com ref inválida ou stale SHALL falhar com erro instruindo a rodar
`browser_snapshot` primeiro. Números de ref SHALL NOT ser reutilizados após
invalidação (contador monotônico), de modo que uma ref pré-navegação nunca
resolva para um elemento pós-navegação.

#### Scenario: ref usada após navegação é rejeitada

- **GIVEN** um snapshot capturou a ref `@e1` numa página
- **WHEN** a página navega (full ou in-page) e o agente age sobre `@e1` sem novo snapshot
- **THEN** a ação falha com erro de ref stale citando `browser_snapshot`

#### Scenario: ref pré-navegação não colide após novo snapshot

- **GIVEN** a página navegou e um novo snapshot foi capturado
- **WHEN** o agente usa uma ref do snapshot antigo
- **THEN** a ação falha com erro de ref stale (o número da ref antiga não foi reutilizado)

#### Scenario: ref fresca funciona

- **GIVEN** um snapshot recém-capturado do documento atual
- **WHEN** o agente age sobre uma ref desse snapshot
- **THEN** a ação resolve o elemento correto normalmente

### Requirement: Remote browser bridge timeout never undercuts the action timeout

O bridge de browser remoto (server → desktop client) SHALL usar um budget de
transporte derivado do `timeoutMs` da ação (com margem e teto), de modo que o
transporte nunca desista antes da ação remota completar — eliminando o replay
de ação (double-submit). O `timeoutMs` aceito pelo runtime de browser tools
SHALL ter teto. Quando o timeout de transporte ainda assim ocorrer, a mensagem
de erro SHALL avisar que a ação pode ter sido executada e recomendar
`browser_snapshot` antes de repetir.

#### Scenario: click com timeout maior que o budget default não causa replay

- **GIVEN** um agente remoto chama `browser_click … navigation 60000`
- **WHEN** o bridge envia a invocação ao desktop client
- **THEN** o budget de transporte é ≥ 60s + margem (não os 30s default)
- **AND** o resultado real do click chega ao agente em vez de um timeout falso

#### Scenario: timeoutMs acima do teto é clampado

- **GIVEN** um agente passa `timeoutMs` acima do teto do runtime
- **WHEN** a ação é executada
- **THEN** o timeout efetivo é o teto (e o budget de transporte respeita seu próprio teto)

#### Scenario: mensagem de timeout avisa sobre possível execução

- **GIVEN** uma invocação de browser remota expira no transporte
- **WHEN** o erro é propagado ao agente
- **THEN** a mensagem contém o aviso de que a ação pode ter sido executada e a recomendação de rodar `browser_snapshot` antes de repetir
