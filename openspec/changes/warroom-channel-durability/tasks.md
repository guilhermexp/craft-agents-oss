## 1. Fase 1 — Durabilidade (bindings, watches, reconciliation)

- [x] 1.1 Módulo de persistência de bindings participante→sessão em `packages/shared/src/channels/` gravando `channels/sessions/<channelId>.json` (validação de shape na leitura, mesmo estilo defensivo de `messages.ts`/`dispatches.ts`)
- [x] 1.2 `ensureParticipantSession` rehydrata o binding do disco; antes de reusar, valida que a sessão ainda existe no sessionManager; inválida/ausente → cria nova e regrava o binding
- [x] 1.3 Watch list de Kanban persistida em `channels/watches/<channelId>.json` (taskIds pendentes por canal), atualizada quando tasks entram/saem do watcher
- [x] 1.4 Boot do `ChannelManager` re-arma watchers a partir das watch lists persistidas (task já terminal no boot → flui direto pro fluxo de task update)
- [x] 1.5 Reconciliation no boot: dispatches em `queued`/`running` no storage → `failed` com error indicando restart (sem watcher/execução correspondente viva)
- [x] 1.6 Testes: instanciar um segundo `ChannelManager` sobre o mesmo workspaceRoot simulando restart — binding de sessão reusado (sessão viva), binding inválido recriado, watcher re-armado, dispatches órfãos reconciliados

## 2. Fase 2 — Loop Kanban completo (todas as superfícies de delegação)

- [ ] 2.1 `dispatchFromSession` arma watch das tasks Kanban criadas durante o turno do dispatch (mesma janela temporal + filtro de assignees usado em `sendMessage`)
- [ ] 2.2 Tasks criadas pelo lead durante `sendTaskUpdate` (re-delegação) também entram no watch
- [ ] 2.3 Registro global persistido de taskIds reivindicados: task já reivindicada por um canal nunca é watchada por outro (primeiro claim ganha); registro sobrevive a restart junto das watch lists
- [ ] 2.4 Testes: task criada em turno de `channel_dispatch` é watchada; task criada em re-delegação é watchada; dois canais com mesmo assignee não recebem a mesma task

## 3. Fase 3 — Robustez de execução + limpeza

- [ ] 3.1 Fila por sessionId no `runtime.sendMessage` do manager: entregas à mesma sessão de participante são serializadas (mata o race do diff before/after)
- [ ] 3.2 Push incremental: resposta de cada participante é appendada ao canal e `MESSAGES_CHANGED` emitido assim que ela chega; retorno RPC final de `sendMessage` permanece com o shape atual
- [ ] 3.3 Timeout por dispatch (default 12 min): ao estourar, dispatch → `failed` com error de timeout e o batch não fica bloqueado; resposta tardia que ainda chegar é appendada ao canal
- [ ] 3.4 Watcher de Kanban relê a config do canal do storage a cada ciclo de poll (participantes editados refletem; canal deletado encerra o watch)
- [ ] 3.5 Texto de usuário não pode forjar molduras de packet: ocorrências de `<<craft-channel-` no texto são neutralizadas nos builders de packet
- [ ] 3.6 Cancel de dispatch: operação RPC marca dispatch `queued`/`running` como `cancelled`; se o sessionManager expuser abort de run, a run é abortada — senão apenas marca (documentar qual dos dois ficou)
- [ ] 3.7 DOX pass: `AGENTS.md` raiz e doc de channels do repo atualizados com o modelo de persistência novo (`channels/sessions`, `channels/watches`, claims)
- [ ] 3.8 Testes: serialização por sessão, timeout marca failed sem travar batch, sanitização de moldura, cancel
