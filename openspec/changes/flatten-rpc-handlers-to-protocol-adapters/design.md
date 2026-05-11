## Contexto

`packages/server-core/src/handlers/rpc/` hoje tem handlers que variam entre pass-through simples e managers implícitos. O alvo desta change é separar a fronteira de protocolo da fronteira de estado:

- Handler RPC: valida/normaliza payload mínimo, chama um método do manager, retorna resposta.
- Manager/serviço: possui lifecycle, watchers, timers, caches, subprocessos, push events e cleanup.

## Inventário de state local

### `packages/server-core/src/handlers/rpc/sessions.ts`

- `packages/server-core/src/handlers/rpc/sessions.ts:15-22`: define `ClientSessionWatchState` e `clientSessionWatches`, um mapa global por client com `FSWatcher`, `sessionId` e `debounceTimer`.
- `packages/server-core/src/handlers/rpc/sessions.ts:40-51`: expõe `cleanupSessionFileWatchForClient`, limpando timer, fechando watcher e removendo estado por client.
- `packages/server-core/src/handlers/rpc/sessions.ts:332-350`: captura `clientId` do caller e emite fallback de `error`/`complete` diretamente pelo handler quando `sessionManager.sendMessage()` rejeita em background.
- `packages/server-core/src/handlers/rpc/sessions.ts:556-588`: `WATCH_FILES` cria watcher recursivo, filtra arquivos internos, aplica debounce de 100ms e faz `pushTyped(...FILES_CHANGED...)` do próprio handler.
- `packages/server-core/src/handlers/rpc/sessions.ts:595-597`: `UNWATCH_FILES` manipula diretamente o estado global do handler.
- `packages/server-core/src/handlers/rpc/sessions.ts:648-657`: `importHandler` é registrado também em `setTransferableHandler`, acoplando import de sessão ao registry global do handler de transfer.

Destino: `SessionManager` deve expor métodos como `watchSessionFilesForClient(clientId, sessionId)`, `unwatchSessionFilesForClient(clientId)`, `cleanupClientSessionState(clientId)` e emitir `FILES_CHANGED` pelo seu event sink. O fallback de erro de streaming deve ficar no método assíncrono do manager ou em um runner controlado por ele. Transferências de sessão devem ser delegadas a um `TransferManager` injetado, não a registry global importado pelo handler.

### `packages/server-core/src/handlers/rpc/channels.ts`

- `packages/server-core/src/handlers/rpc/channels.ts:18-27`: mantém `orchestrators`, `watchedKanbanTasks` e `kanbanWatchTimer` em module scope.
- `packages/server-core/src/handlers/rpc/channels.ts:33-68`: `getOrchestrator()` cria e cacheia `ChannelOrchestrator`, incluindo runtime que cria sessões e envia mensagens via `SessionManager`.
- `packages/server-core/src/handlers/rpc/channels.ts:84-113`: `watchKanbanTasks()` armazena tarefas por channel, guarda `deps` e `server`, inicia `setInterval` e usa `unref`.
- `packages/server-core/src/handlers/rpc/channels.ts:115-168`: `pollWatchedKanbanTasks()` lê Kanban, muta o mapa de watchers, grava mensagens de sistema/agente, chama orquestrador e emite `MESSAGES_CHANGED`.
- `packages/server-core/src/handlers/rpc/channels.ts:231-299`: `SEND_MESSAGE` faz dispatch, persiste mensagens, detecta tarefas Kanban criadas e registra watchers no mesmo handler.

Destino: um `ChannelManager` ou extensão explícita do `ChannelOrchestrator` deve possuir cache de orquestradores, polling de Kanban, storage de watchers e emissão de eventos. O handler deve chamar `channelManager.sendMessage(workspaceId, input)` e retornar o resultado.

### `packages/server-core/src/handlers/rpc/workspace.ts`

- `packages/server-core/src/handlers/rpc/workspace.ts:38-40`: captura `sessionManager` e `windowManager`, mas não cria state persistente próprio.
- `packages/server-core/src/handlers/rpc/workspace.ts:78-87`: `GET_WORKSPACE` dispara `sessionManager.setupConfigWatcher(...)`; o state fica no `SessionManager`.
- `packages/server-core/src/handlers/rpc/workspace.ts:96-135`: `SWITCH_WORKSPACE` atualiza roteamento do client/window, limpa active viewing e chama `setupConfigWatcher(...)`; a mutação de state real fica em `server`, `windowManager` e `SessionManager`.
- `packages/server-core/src/handlers/rpc/workspace.ts:313-315` e `348-350`: broadcasts de tema saem diretamente do handler, mas não guardam state local.

Destino: manter como adapter no primeiro passe, mas mover operações de workspace/window para um manager se o refactor criar uma fronteira `WorkspaceManager`. O requisito principal aqui é não adicionar state novo ao handler.

### `packages/server-core/src/handlers/rpc/messaging.ts`

- `packages/server-core/src/handlers/rpc/messaging.ts:9-12`: pega `deps.messagingRegistry` e retorna se ausente.
- `packages/server-core/src/handlers/rpc/messaging.ts:13-77`: handlers são pass-through para o registry, com validação de `workspaceId`.

Destino: já é o formato desejado. Manter como referência de protocol adapter puro.

### `packages/server-core/src/handlers/rpc/hermes.ts`

- `packages/server-core/src/handlers/rpc/hermes.ts:43-57`: mantém `dashboardProcess`, `dashboardUrl`, `dashboardPort`, `dashboardStartPromise`, tokens de dashboard, monitor de update marker, watcher de `auth.json`, flags de sync e debounce timer em module scope.
- `packages/server-core/src/handlers/rpc/hermes.ts:132-162`: `shutdownHermesDashboard()` opera diretamente sobre `dashboardProcess`.
- `packages/server-core/src/handlers/rpc/hermes.ts:350-390`: `startHermesUpdateMarkerMonitor()` cria e mantém `setInterval`, path monitorado e mtime do marker.
- `packages/server-core/src/handlers/rpc/hermes.ts:487-505`: `getDashboardSessionToken()` cacheia token e URL no handler.
- `packages/server-core/src/handlers/rpc/hermes.ts:955-986`: `startHermesAuthJsonWatcher()` cria `fs.watch`, debounce e sync de token a partir do handler.
- `packages/server-core/src/handlers/rpc/hermes.ts:988-990`: `registerHermesHandlers()` inicia watcher de auth no registro do handler e cria `gatewayRestartTimer` local.
- `packages/server-core/src/handlers/rpc/hermes.ts:1028-1040`: `ensureDashboardRunning()` reutiliza processo e promise globais do dashboard no handler.
- `packages/server-core/src/handlers/rpc/hermes.ts:858-898`: `runUpdateScript()` mantém subprocesso, buffer de output e timeout dentro do módulo RPC.

Destino: extrair para `HermesRuntimeManager` ou serviço equivalente com lifecycle explícito: dashboard process, dashboard token, update monitor, auth watcher, restart debounce e update subprocess. O handler chama métodos como `hermesRuntime.startDashboard()`, `hermesRuntime.getRuntimeDetails()`, `hermesRuntime.patchApiConfig()` e `hermesRuntime.shutdownDashboard()`.

### `packages/server-core/src/handlers/rpc/sources.ts`

- `packages/server-core/src/handlers/rpc/sources.ts:21-23`: captura logger, sem state próprio.
- `packages/server-core/src/handlers/rpc/sources.ts:151-242`: `GET_MCP_TOOLS` cria `CraftMcpClient` temporário e fecha após listar tools; é operação pesada no handler, mas não mantém state local persistente.

Destino: mover descoberta de MCP tools para um source manager/service para reduzir fixture de handler, mas sem requisito de migração de state persistente.

### `packages/server-core/src/handlers/rpc/transfer.ts`

- `packages/server-core/src/handlers/rpc/transfer.ts:23-35`: define `TransferState` com owner client, chunks recebidos, args diferidos e timer.
- `packages/server-core/src/handlers/rpc/transfer.ts:39-40`: mantém `activeTransfers` e `transferableHandlers` em module scope.
- `packages/server-core/src/handlers/rpc/transfer.ts:47-64`: `cleanupTransfer()` limpa timer, estado e diretório temporário.
- `packages/server-core/src/handlers/rpc/transfer.ts:66-72`: `rescheduleTransferCleanup()` gerencia TTL com `setTimeout`.
- `packages/server-core/src/handlers/rpc/transfer.ts:80-90`: registry global de handlers transferíveis e reset de testes vivem no handler.
- `packages/server-core/src/handlers/rpc/transfer.ts:120-139`: `START` aloca diretório temporário, cria estado e agenda cleanup.
- `packages/server-core/src/handlers/rpc/transfer.ts:151-174`: `CHUNK` muta `received`, escreve arquivo e reagenda TTL.
- `packages/server-core/src/handlers/rpc/transfer.ts:177-250`: `COMMIT` reassembla payload, valida checksum, chama handler diferido e limpa estado.
- `packages/server-core/src/handlers/rpc/transfer.ts:252-260`: `ABORT` remove estado ativo.

Destino: extrair para `TransferManager` com ownership de TTL, temp dirs, ownership por client e registry de destinos. O RPC handler deve chamar `transferManager.start(ctx, opts)`, `chunk(ctx, opts)`, `commit(ctx, opts)` e `abort(ctx, opts)`.

## Shape do protocol adapter puro

Um handler puro deve seguir este shape:

```ts
server.handle(CHANNEL, async (ctx, payload) => {
  const input = parsePayload(payload)
  return manager.method({ ctx, ...input })
})
```

Regras:

- Sem `Map`, `Set`, `FSWatcher`, `ChildProcess`, `setTimeout`, `setInterval` ou cache mutável em module scope do handler.
- Sem `pushTyped` para eventos derivados de state que o manager possui. O manager deve emitir eventos pelo event sink.
- Sem registrar callbacks globais de outros handlers. Dependências transversais devem ser injetadas como managers/serviços.
- Validação de payload pode ficar no adapter; decisões de lifecycle e cleanup ficam no manager.

## Distribuição de responsabilidades

- `SessionManager`: state por client de sessão, file watchers, debounce de `FILES_CHANGED`, fallback de erro de `sendMessage`, cleanup em desconexão, e delegação para `TransferManager` quando a transferência é de sessão.
- `ChannelManager` ou `ChannelOrchestrator`: cache de orquestradores por workspace/channel, polling de Kanban, lista de tasks observadas, gravação de mensagens de sistema/agente e push de `MESSAGES_CHANGED`.
- `HermesRuntimeManager`: dashboard process, porta, URL, start promise, session token, update marker monitor, auth watcher, debounce de auth e subprocesso de update.
- `TransferManager`: active transfers, TTL, chunks, temp dirs, checksum, registry de handlers transferíveis e cleanup por owner client.
- `WorkspaceManager` futuro: se necessário, centraliza workspace switching, window mapping e broadcasts de preferências. Não é bloqueador para esta change.
- `MessagingRegistry`: permanece como manager existente para `messaging.ts`.
- `SourceService` futuro: pode absorver `GET_MCP_TOOLS` para reduzir lógica no handler, mas não bloqueia o requisito de remover state local.

## Tests

- Handler tests devem mockar managers e verificar somente parsing, roteamento de método, erro de payload e retorno.
- Manager tests devem cobrir lifecycle real: watchers, debounce, timers, cleanup, push events e falhas de subprocesso.
- Testes de integração existentes continuam cobrindo fluxo completo onde há risco de regressão: sessão -> push event, canal -> mensagem de agente, Hermes dashboard -> start/update/auth sync, transfer -> chunks/commit/abort.
- Validação específica: simular disconnect de client e confirmar que watchers/transfers associados são limpos pelo manager, não por função exportada do handler.
- Validação de push events: confirmar que `FILES_CHANGED`, `channels.MESSAGES_CHANGED`, eventos Hermes e eventos de transferência continuam chegando ao client correto após a extração.

## Trade-offs

- Managers ficam um pouco mais pesados, mas concentram ownership de recursos e cleanup.
- A extração pode exigir interfaces novas para event sink e client lifecycle, mas reduz acoplamento entre handlers e transporte.
- O refactor deve ser incremental, um handler por vez, para preservar comportamento e facilitar bisect.
- Alguns handlers continuarão contendo validação ou transformação local curta; isso é aceitável desde que não guardem state persistente nem possuam lifecycle.
