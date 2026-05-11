- [x] Análise: anotar linhas por responsabilidade no `SessionManager.ts`.
- [x] Extrair `SessionMessageStore` para persistência append-only, lazy load, flush e truncamento explícito.
- [x] Extrair `SessionArtifactRenderer` para Mermaid/SVG assíncrono e rate-limited.
- [x] Extrair `SessionEventPublisher` para eventos RPC, broadcasts e batching de deltas.
- [x] Extrair `SessionLifecycleManager` para create, send, branch, rollback, cancel, delete e transfer.
- [x] Refatorar `SessionManager.ts` como aggregate fino que compõe os submódulos.
- [x] Atualizar RPC handler `sessions.ts` para delegar artefatos, watcher e comandos ao aggregate/submódulos.
- [x] Cobrir cada submódulo com testes isolados e fakes/mocks dos outros domínios.
- [x] Atualizar spec `session-management`.
- [ ] (out-of-scope) `cd packages/server-core && bun run tsc --noEmit` ainda falha em `src/channels/channel-orchestrator.test.ts:27` por `string` não atribuível a `WarRoomChannelId`; não pertence à capability desta change.

## Análise por responsabilidade

- `packages/server-core/src/sessions/SessionManager.ts:1186-1329`: aggregate, wiring de event sink, browser pane manager e watcher de arquivos por cliente.
- `packages/server-core/src/sessions/SessionManager.ts:1850-1956`: carregamento inicial, persistência, flush e lazy-load de mensagens; extraído para `SessionMessageStore`.
- `packages/server-core/src/sessions/SessionManager.ts:2420-2820`: create/branch e preparação de backend ativo; fronteira coberta por `SessionLifecycleManager`.
- `packages/server-core/src/sessions/SessionManager.ts:5147-5235`: delete/cancel cleanup de sessão; delta cleanup delegado para `SessionEventPublisher`.
- `packages/server-core/src/sessions/SessionManager.ts:5235-5765`: `sendMessage` e coordenação de turno/processamento; lifecycle permanece compatível via aggregate.
- `packages/server-core/src/sessions/SessionManager.ts:6532-7128`: processamento de eventos runtime e publicação de eventos/deltas; batching extraído para `SessionEventPublisher`.
- `packages/server-core/src/handlers/rpc/sessions.ts:494-520`: adapter RPC de files/watch; artefatos Mermaid delegados para `SessionManager.getSessionFiles()` e `SessionArtifactRenderer`.
