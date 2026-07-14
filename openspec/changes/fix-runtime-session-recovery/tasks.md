## 1. F2.1 — Recovery do subprocess Hermes

- [ ] 1.1 Estender `AcpProviderInternalShape` com `agentProcess` e registrar observer de `exit` após `initSession()` (idempotente por processo, guardado por `this.provider === provider`)
- [ ] 1.2 Exit observado: se ocioso → `provider.cleanup()` + `provider=null` + `providerRuntimeHome=null`; se mid-turn → `pendingProviderRestart=true` (o `finally` existente reseta)
- [ ] 1.3 Fallback no `catch` do `chatImpl`: erro de I/O do pipe (EPIPE/ECONNRESET/stream destroyed/write after end) marca `pendingProviderRestart`; erro de negócio não reseta
- [ ] 1.4 Teste: morte simulada do processo → próximo turno respawna (provider antigo limpo); erro de negócio não derruba o provider

## 2. F2.2 — supportsBranching por provider

- [ ] 2.1 `BACKEND_CAPABILITIES` ganha `supportsBranching` (anthropic/pi: true, hermes: false)
- [ ] 2.2 `resolveSupportsBranching` com agent lazy resolve via `resolveBackendContext(llmConnection, model)` em vez de `true` cego
- [ ] 2.3 `createSession` rejeita `branchFrom*` quando o backend alvo não suporta branching
- [ ] 2.4 Teste isolado: sessão Hermes restaurada (agent null) reporta `supportsBranching=false`; Claude/Pi seguem true

## 3. F2.3 — Invalidação de refs por navegação

- [ ] 3.1 `BrowserCDP` registra `did-navigate` + `did-navigate-in-page` no construtor → limpa `refMap`/`refDetails`/`backendNodeRefMap` (`nextRefCounter` nunca reseta)
- [ ] 3.2 Resolução de ref centralizada em helper único (`click`/`fill`/`select`/geometry) com erro "stale ref — run browser_snapshot first"
- [ ] 3.3 Atualizar `apps/electron/docs/embedded-browser-cdp-replication.md` para o comportamento real
- [ ] 3.4 Teste: ref usada após navegação é rejeitada; ref fresca de novo snapshot funciona; maps não crescem sem bound

## 4. F2.4 — Timeout do bridge remoto sem replay

- [ ] 4.1 `invokeClientWithTimeout(clientId, channel, timeoutMs, ...args)` no transporte; `invokeClient` delega com 30s
- [ ] 4.2 `requestClientBrowserInvoke` deriva budget do maior `timeoutMs` nos args (+5s margem, piso 30s, teto 150s)
- [ ] 4.3 Timeout do bridge: mensagem avisa "a ação pode ter sido executada — rode browser_snapshot antes de repetir"
- [ ] 4.4 `timeoutMs` do browser-tool-runtime com teto de 120s
- [ ] 4.5 Teste: budget derivado corretamente; timeoutMs acima do teto é clampado; mensagem contém o aviso

## 5. Validação

- [ ] 5.1 `HOME=/tmp/craft-worker-home bun run validate:ci` → exit 0
- [ ] 5.2 `browser-pane-manager.test.ts` sem novos fails (baseline 64 pass / 8 fail)
- [ ] 5.3 `openspec validate fix-runtime-session-recovery --strict --no-interactive` → verde
