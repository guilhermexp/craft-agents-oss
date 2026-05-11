## Context

Channels / War Room já existe como uma camada de sala compartilhada no Craft. O modelo atual separa a superfície visível do canal das sessões privadas dos agentes: o usuário escreve em um canal, o servidor persiste a mensagem no workspace storage e o orquestrador despacha trabalho para uma ou mais sessões Craft/Hermes conforme o modo de roteamento.

A arquitetura principal é:

`ChannelConversationPanel` (UI) ↔ `channels` RPC ↔ `ChannelOrchestrator` ↔ Sessions (Craft + Hermes lead).

Os tipos centrais são:

- `Channel`: configuração do canal, incluindo nome, descrição, label de apoio, membros e roteamento.
- `ChannelMember` / `ChannelParticipant`: participante endereçável por menção, com conexão LLM, modelo opcional e perfil Hermes opcional.
- `ChannelMessage`: item de histórico compartilhado, com autor, texto, participantes acionados e sessão de origem quando aplicável.
- `RoutingMode`: `manual-tags`, `lead`, `all` ou `orchestrator`.

O storage atual fica dentro do workspace:

- `channels/config.json` para configuração dos canais.
- `channels/messages/<channelId>.jsonl` para histórico de mensagens por canal.

## Goals / Non-Goals

**Goals:**

- Documentar o contrato existente de Channels / War Room como capability OpenSpec.
- Preservar que canais são salas compartilhadas com histórico próprio, membros e mensagens.
- Especificar os quatro modos de roteamento e a inferência de lead Hermes quando `leadParticipantId` está vazio.
- Registrar Hermes Kanban como fonte de estado para o modo `orchestrator`.
- Fixar `packages/shared/src/protocol/channels.ts` como contrato RPC canônico.

**Non-Goals:**

- Alterar código de produto ou testes nesta change retroativa.
- Redesenhar a UI do canal.
- Trocar o mecanismo de storage do workspace.
- Unificar histórico privado das sessões dos agentes com o histórico do canal.

## Decisions

### Channel Log É a Superfície Compartilhada

O canal mantém mensagens próprias no workspace storage e as sessões de agente são detalhes de execução. Isso permite que participantes diferentes recebam contexto recente do canal sem exigir que suas sessões privadas compartilhem histórico interno.

Alternativa considerada: tratar canal como label aplicada a sessões. Isso foi rejeitado porque labels não carregam conversa compartilhada, membros nem semântica de roteamento.

### RPC de Channels É o Contrato Canônico

`packages/shared/src/protocol/channels.ts` define os nomes estáveis de RPC para listar, criar, atualizar, deletar, listar mensagens e enviar mensagens. Cliente e servidor devem obedecer esses canais para manter paridade entre Electron IPC, renderer e server-core.

Alternativa considerada: deixar cada camada montar strings próprias de evento. Isso foi rejeitado porque aumenta drift entre cliente e servidor.

### Roteamento Fica no ChannelOrchestrator

O `ChannelOrchestrator` centraliza a resolução de targets:

- `manual-tags`: somente participantes mencionados recebem trabalho; mensagens sem menção ficam no canal.
- `lead`: menções explícitas vencem; se não houver menções, a mensagem vai para o lead.
- `all`: mensagens sem menção vão para todos os participantes; `@all` pode expandir para todos.
- `orchestrator`: a mensagem vai para o lead/orquestrador, que decide delegação via War Room.

Alternativa considerada: resolver roteamento na UI. Isso foi rejeitado porque o servidor precisa ser a autoridade para mensagens, falhas, dispatch real e automações Kanban.

### Lead Hermes É Inferido Quando Não Configurado

Em `lead` e `orchestrator`, `leadParticipantId` não é obrigatório. O sistema deve escolher primeiro o participante indicado por `leadParticipantId`, depois o primeiro participante Hermes, depois o primeiro participante do canal. Sem participantes, não há alvo.

Alternativa considerada: exigir `leadParticipantId`. Isso foi rejeitado porque torna salas `lead`/`orchestrator` inúteis até configuração manual extra e quebra o comportamento Slack-like esperado.

### Hermes Kanban É o Estado de Delegação do War Room

No modo `orchestrator`, Hermes recebe um pacote com roster de workers e instruções para criar tarefas no Kanban usando o `HERMES_HOME` app-scoped. O reader `hermes-kanban` lê o board atual, filtra tarefas por assignees esperados do canal e publica updates terminais de volta no canal.

Alternativa considerada: armazenar tarefas de War Room diretamente no channel storage. Isso foi rejeitado para manter compatibilidade com o runtime Hermes e com o board Hermes existente.

## Risks / Trade-offs

- Risco: tarefas Kanban não relacionadas vazarem para um canal. Mitigação: filtrar updates por assignees esperados do canal.
- Risco: usuário não perceber se uma mensagem acionou agentes. Mitigação: a UI deve mostrar estado de envio, participantes acionados, menções desconhecidas e falhas.
- Risco: sessões de agentes perderem contexto compartilhado. Mitigação: enviar mensagens recentes do canal nos pacotes de orquestração.
- Risco: drift entre IPC/renderer/server. Mitigação: manter `RPC_CHANNELS.channels` como fonte da verdade.

## Migration Plan

Esta change é retroativa e não exige migração. A aplicação já persiste canais em `channels/config.json` e mensagens por canal em JSONL dentro do workspace.

Rollback consiste em remover esta change OpenSpec antes de arquivar; nenhum dado de runtime ou código de produto é alterado.

## Open Questions

Nenhuma para o bootstrap retroativo. Mudanças futuras devem abrir deltas específicos para a capability `channels-war-room`.
