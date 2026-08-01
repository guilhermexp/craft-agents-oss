## ADDED Requirements

### Requirement: Right sidebar manages deterministic persistent content tabs

A sidebar direita SHALL abrir file e object targets em tabs com IDs
determinísticos. Cada scope SHALL ter no máximo uma tab preview substituível;
tabs permanentes ou pinned MUST sobreviver a novos previews. Restore SHALL ser
workspace-scoped e MUST reparar active selection inválida.
Identidade de file target MUST incluir `workspaceId`, `sessionId` e path
normalizado. Identidade de object target MUST incluir `workspaceId`, `objectId`
e `viewId` quando presente.

#### Scenario: Preview substitui somente preview

- **GIVEN** uma tab preview e uma tab pinned
- **WHEN** outro conteúdo abre em modo preview
- **THEN** somente a tab preview é substituída e a pinned permanece
- **Test:** `unit`

#### Scenario: Restore contém active target ausente

- **WHEN** tabs persistidas são restauradas sem o active target
- **THEN** a seleção muda deterministicamente para uma tab válida ou empty state
- **Test:** `unit`

#### Scenario: Sessão muda

- **WHEN** a sidebar passa a representar outra sessão
- **THEN** targets de arquivo da sessão anterior não são renderizados na nova sessão
- **Test:** `integration`

### Requirement: Content resolver is bounded and generation-safe

O resolver SHALL manter no máximo 20 payloads, SHALL remover o payload evicted,
SHALL preservar o último payload durante revalidation e MUST usar cancelamento e
generation guards em load inicial e refresh.

#### Scenario: Payload vinte e um é aberto

- **GIVEN** vinte payloads cached e inativos elegíveis
- **WHEN** outro payload é resolvido
- **THEN** o least-recent payload é removido do cache e não apenas da ordem LRU
- **Test:** `unit`

#### Scenario: Refresh antigo conclui por último

- **GIVEN** um refresh anterior ainda em voo
- **WHEN** uma generation nova conclui antes dele
- **THEN** o resultado anterior não substitui o payload novo
- **Test:** `unit`

#### Scenario: Revalidation falha

- **GIVEN** um payload previamente carregado
- **WHEN** o refresh falha
- **THEN** o payload anterior permanece visível com erro e ação explícita de retry
- **Test:** `integration`

#### Scenario: Transporte reconecta

- **WHEN** a subscription de workspace é restabelecida
- **THEN** lista e objeto ativo recebem exatamente uma invalidação de reload sem descartar payload stale
- **Test:** `integration`

### Requirement: Content renderer dispatch remains modular

File e object payloads SHALL ser uma união discriminada e SHALL ser roteados por
um registry de conteúdo. A Phase A MUST reutilizar renderers atuais e MUST
preservar o routing especializado de PDF, áudio e tipos sem preview inline.

#### Scenario: Objeto tabular abre na sidebar

- **WHEN** um object payload tabular é selecionado
- **THEN** o registry usa o renderer tabular existente sem alterar o file tree
- **Test:** `integration`

#### Scenario: PDF continua especializado

- **WHEN** um PDF é selecionado na árvore atual
- **THEN** ele continua no viewer especializado definido pela classificação existente
- **Test:** `integration`
