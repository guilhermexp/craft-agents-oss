## Why

Análise do subsistema War Room em 2026-07-19 (orquestrador, sessão 260719-windy-seal) confirmou que o design de roteamento está correto e testado, mas o runtime não é durável nem fecha o loop de delegação além da primeira rodada:

1. **Estado só em memória** — `participantSessions` (channel-orchestrator), `orchestrators` e `watchedKanbanTasks` (channel-manager) são Maps voláteis. Restart do app: sessões de participante são recriadas (órfãs acumulam, memória privada do agente se perde), watchers de Kanban somem (resultado de task nunca volta ao canal) e dispatches ficam `queued`/`running` para sempre — não há reconciliation no boot.
2. **Watch de Kanban só na primeira rodada** — o watch é armado apenas em `ChannelManager.sendMessage`. Tasks criadas por um worker via `channel_dispatch` ou pelo lead ao re-delegar após um `sendTaskUpdate` nunca são observadas: a segunda rodada de delegação morre no Kanban.
3. **Atribuição task→canal por janela temporal** — dois canais com o mesmo assignee Hermes (ou task criada manualmente no mesmo segundo) podem entregar a mesma task a canais errados/duplicados.
4. **Sem serialização por sessão** — duas mensagens rápidas no canal geram `sendMessage` concorrentes na mesma sessão de participante; a detecção de resposta por diff de message IDs pode casar a resposta errada.
5. **Respostas em batch, sem timeout** — no modo `all`, o participante mais lento segura todas as respostas; um agente travado bloqueia o canal indefinidamente.
6. **Miudezas** — status `cancelled` existe no tipo e nunca é usado; watcher usa snapshot stale do canal; texto do usuário pode forjar as molduras `<<craft-channel-...>>` dos packets.

## What Changes

- **Fase 1 — Durabilidade:** bindings participante→sessão persistidos em `channels/sessions/`, watch lists de Kanban persistidas em `channels/watches/` (mesmo padrão JSONL/JSON de `channels/messages` e `channels/dispatches`), rehydrate com validação de sessão viva, e reconciliation no boot do `ChannelManager` (dispatches órfãos → `failed`, watchers re-armados).
- **Fase 2 — Loop Kanban completo:** watch armado também em `dispatchFromSession` e após `sendTaskUpdate`; registro global persistido de taskIds reivindicados garante que cada task pertence a exatamente um canal (primeiro claim ganha).
- **Fase 3 — Robustez de execução:** fila por sessionId serializa entregas na mesma sessão; respostas de participantes são appendadas e notificadas incrementalmente (retorno RPC inalterado); timeout por dispatch (default 12 min) marca `failed` sem travar o batch e ainda aceita resposta tardia; watcher relê a config do canal a cada ciclo; sanitização das molduras de packet; cancel de dispatch usando o status `cancelled`; DOX pass nos docs.

## Impact

- Affected specs: `channels-war-room`
- Affected code: `packages/shared/src/channels/` (novo módulo de persistência de sessões/watches), `packages/server-core/src/channels/channel-manager.ts`, `packages/server-core/src/channels/channel-orchestrator.ts`, testes correspondentes, `AGENTS.md`/docs de channels.
- Sem mudança de contrato RPC visível para a UI (retornos preservados; push `MESSAGES_CHANGED` passa a ser emitido também incrementalmente).
- Formato on-disk novo: `channels/sessions/<channelId>.json`, `channels/watches/<channelId>.json`, registro de claims de tasks — todos aditivos; nada existente muda de formato.
