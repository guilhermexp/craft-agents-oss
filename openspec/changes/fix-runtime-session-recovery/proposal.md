## Why

A auditoria de runtime de 2026-07-14 (fase F2) encontrou 4 bugs de correctness
que quebram função real em uso normal:

1. **F2.1** — Se o subprocess Python do Hermes morre no meio de um turno, o
   `catch` do streaming só emite `{type:'error'}` e o provider/`agentProcess`
   ficam stale. Todo turno seguinte escreve num pipe morto (EPIPE opaco) — a
   sessão fica inutilizável até reiniciar o app. O dep
   `@mcpc-tech/acp-ai-provider@0.3.3` não registra listener de `exit`.
2. **F2.2** — `resolveSupportsBranching` cai em `return true` cego quando o
   agent é lazy (null após restore). Sessões Hermes restauradas reportam
   `supportsBranching=true`, a UI oferece branch, e o branch resultante tem
   amnésia silenciosa (Hermes não consome `branchFrom*` — só Claude/Pi via
   sdk-fork).
3. **F2.3** — Refs `@eN` do browser agêntico nunca são invalidadas por
   navegação (`backendNodeRefMap` nunca é limpo; não há hook `did-navigate`).
   Em SPAs/pós-navegação o agente clica/preenche o elemento errado. O doc
   `embedded-browser-cdp-replication.md` afirma "refs invalid after page
   changes" — o código não garante isso. Os maps também crescem sem bound
   (leak).
4. **F2.4** — `invokeClient` do transporte rejeita em 30s fixos, mas
   `browser_click … navigation 60000` executa o click no desktop e só então
   espera a navegação. O server desiste em 30s, o agente vê "timeout" e
   re-clica → double-submit (replay de ação remota).

## What Changes

- **F2.1** — `HermesAgent` passa a observar o `exit` do `agentProcess` do
  provider ACP (via internals já acessados para permission/stream handlers).
  Morte do subprocess → reset do provider (`cleanup()` provider-level +
  `provider=null`) imediato se ocioso, ou via `pendingProviderRestart` se
  mid-turn (o `finally` existente já faz o reset). Fallback: o `catch` do
  streaming detecta erros de I/O do pipe (EPIPE/ECONNRESET/stream destroyed) e
  marca `pendingProviderRestart`. Erros de negócio (rate-limit etc.) **não**
  resetam o provider. Nenhuma mudança nas factories Claude/Pi.
- **F2.2** — `BACKEND_CAPABILITIES` ganha `supportsBranching` declarativo
  (anthropic/pi: true, hermes: false). `resolveSupportsBranching` usa
  `resolveBackendContext(...)` no fallback lazy em vez de `true` cego. O
  `createSession` rejeita `branchFrom*` quando o backend alvo não suporta
  branching. Branching Claude/Pi inalterado.
- **F2.3** — `BrowserCDP` limpa `refMap`/`refDetails`/`backendNodeRefMap` em
  `did-navigate` e `did-navigate-in-page`. `nextRefCounter` nunca reseta, então
  refs pré-navegação jamais colidem com refs pós-navegação (equivalente a
  epoch por snapshot, sem bookkeeping extra). Resolução de ref centralizada em
  helper único com erro "stale ref — run browser_snapshot first". Doc
  `embedded-browser-cdp-replication.md` atualizado para o comportamento real.
- **F2.4** — `invokeClient` ganha timeout parametrizável por chamada
  (`invokeClientWithTimeout`); o bridge de browser
  (`requestClientBrowserInvoke`) deriva o budget do `timeoutMs` da ação
  (+margem, com teto), então o transporte nunca desiste antes da ação remota —
  sem replay. `timeoutMs` do runtime de browser tools ganha teto (120s). A
  mensagem de timeout do bridge avisa que a ação pode ter sido executada e
  recomenda `browser_snapshot` antes de repetir.

## Impact

- Affected specs: `agent-backends` (F2.1), `session-management` (F2.2),
  `session-tools-mcp` (F2.3, F2.4).
- Affected code:
  - `packages/shared/src/agent/hermes-agent.ts` — observer de exit + detecção
    de erro de I/O no catch.
  - `packages/shared/src/agent/backend/factory.ts` — `supportsBranching` em
    `BACKEND_CAPABILITIES`.
  - `packages/server-core/src/sessions/SessionManager.ts` — fallback por
    provider em `resolveSupportsBranching` + rejeição de `branchFrom*` para
    backend sem suporte.
  - `apps/electron/src/main/browser-cdp.ts` — invalidação de refs por
    navegação + helper de resolução com erro de stale ref.
  - `apps/electron/docs/embedded-browser-cdp-replication.md` — doc alinhado.
  - `packages/server-core/src/transport/{server,types,capabilities}.ts` —
    timeout parametrizável + budget do bridge de browser + mensagem de replay.
  - `packages/shared/src/agent/browser-tool-runtime.ts` — teto do `timeoutMs`.
- Risco: baixo. Cada fix é local, coberto por teste de integração contra o
  código real, e não muda contratos públicos de tools (`v1` intacto).
