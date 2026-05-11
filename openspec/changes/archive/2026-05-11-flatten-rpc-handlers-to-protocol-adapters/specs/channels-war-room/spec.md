## ADDED Requirements

### Requirement: State de canais pertence ao manager de canais
O sistema SHALL manter cache de orquestradores, watchers de Kanban, timers de polling e emissão de eventos de mensagens em um manager ou orquestrador de canais, não no handler RPC.

#### Scenario: Mensagem de canal é enviada
- **WHEN** um client envia uma mensagem para um canal
- **THEN** o handler RPC encaminha o payload ao manager de canais
- **AND** o manager resolve participantes, cria ou reutiliza sessões alvo e persiste mensagens de usuário/agente.

#### Scenario: Tarefa Kanban criada durante dispatch
- **WHEN** o dispatch de canal cria tarefas Kanban atribuídas a participantes do canal
- **THEN** o manager de canais registra as tarefas observadas e controla o polling até estado terminal.

#### Scenario: Tarefa Kanban chega a estado terminal
- **WHEN** uma tarefa observada chega a `done`, `blocked` ou `archived`
- **THEN** o manager de canais adiciona a atualização ao histórico do canal e emite o evento de mensagens alteradas para os clients do workspace.
