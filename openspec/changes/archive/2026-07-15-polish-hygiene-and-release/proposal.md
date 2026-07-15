## Why

A auditoria de 2026-07-14 (fase F6) apontou 8 itens de higiene, specs e DX:

1. **F6.1** — `release.yml` tem `fail-fast: false` + upload por job com
   `fail_on_unmatched_files: false`. Se o build Windows falha, a Release
   draft nasce só com os artefatos macOS, **silenciosamente** — um humano
   pode publicar sem o `.exe`. A spec `release` contradiz a si mesma: um
   cenário aceita a draft parcial, outro espera todos os artefatos.
2. **F6.2** — o requirement "Bot recebe contexto da reunião" da spec
   `meetings` promete entrega "ao bot E à sessão Craft", mas os cenários só
   asseram o lado Craft. No código, o bot recebe apenas link normalizado,
   guest name, modo e auth state — participantes/agenda não são coletados
   em lugar nenhum.
3. **F6.3** — o fluxo dashboard "Update Hermes" (`update-hermes-runtime.sh`)
   herda `HERMES_SRC` do ambiente e pula pin + overlay patches em silêncio.
4. **F6.4** — `check-session-tool-contracts.ts` valida o shape corrente mas
   não compara contra snapshot committed: mutação incompatível in-place de
   um tool `v1` passa verde.
5. **F6.5** — `SessionManager.cleanup()` para watchers/automations mas não
   chama `destroy()` nos agents ativos; o reaper de startup só cobre o
   dashboard Hermes, não órfãos `-m acp_adapter`.
6. **F6.6** — os serviços de meetings chamam `createBackendFromConnection`
   sem `hostRuntime` → em build empacotado (cwd=/) resolvem runtime nativo
   com `isPackaged: false` e `appRootPath: '/'`.
7. **F6.7** — `browser console`/`browser network`/`window_resize` no modo
   remoto retornam vazio/eco: o `RemoteBrowserPaneManager` descarta o
   resultado do invoke WS porque a interface só tem a forma sync local-only.
8. **F6.8** — `console.log('CRAFT_SERVER_TOKEN=…')` em headless expõe o
   bearer do RPC local em stdout/logs.

## What Changes

- **F6.1** — job `finalize` no `release.yml` (`needs: build`, `if: always()`)
  que confere os assets da draft contra o conjunto esperado de plataformas e,
  se faltar algo, marca a draft visivelmente como incompleta (nome + corpo
  com "⚠️ INCOMPLETE — missing: <plataformas>"). Parcial continua permitido,
  nunca silencioso. Spec `release` alinhada.
- **F6.2** — requirement da spec `meetings` reescrito para refletir o código:
  bot recebe link/identidade/modo no payload de start (cenário novo assere o
  lado do bot); participantes/agenda não são coletados hoje.
- **F6.3** — `update-hermes-runtime.sh` faz `unset HERMES_SRC` herdado, salvo
  `HERMES_ALLOW_SRC_OVERRIDE=1` explícito (com aviso).
- **F6.4** — golden file committed (`scripts/session-tool-contracts.golden.json`)
  com os 28 schemas v1; o checker assere igualdade contra o golden e ganha
  `--update` para regenerar explicitamente.
- **F6.5** — `cleanup()` itera as sessões chamando `managed.agent?.destroy()`;
  reaper de startup também mata órfãos `-m acp_adapter` do python vendorizado.
- **F6.6** — os dois serviços de meetings passam host runtime context
  (mesmo shape que `createElectronPlatform`) no 3º arg de
  `createBackendFromConnection`.
- **F6.7** — async twins `getConsoleLogsAsync`/`getNetworkLogsAsync`/
  `windowResizeAsync` na `IBrowserPaneManager` (padrão `getInstanceAsync`);
  os 3 callbacks do SessionManager passam a usá-los.
- **F6.8** — token fora do stdout por padrão: server standalone só ecoa com
  `CRAFT_DEBUG_PRINT_TOKEN=1` (o operador já fornece o token via env);
  Electron headless grava o token em arquivo `0600` e imprime
  `CRAFT_SERVER_TOKEN_FILE=<path>`.

## Impact

- Specs afetadas: `release` (sinalização de release parcial), `meetings`
  (contrato de contexto do bot).
- Código: `.github/workflows/release.yml`,
  `apps/electron/scripts/update-hermes-runtime.sh`,
  `scripts/check-session-tool-contracts.ts` (+ golden novo),
  `packages/server-core/src/sessions/SessionManager.ts`,
  `packages/server-core/src/handlers/rpc/hermes.ts`,
  `packages/server-core/src/handlers/browser-pane-manager-interface.ts`,
  `packages/server-core/src/sessions/RemoteBrowserPaneManager.ts`,
  `packages/server-core/src/runtime/null-browser-pane-manager.ts`,
  `apps/electron/src/main/browser-pane-manager.ts`,
  `apps/electron/src/main/meetings/{meeting-summary-service,meeting-video-analysis-service}.ts`,
  `apps/electron/src/main/index.ts`, `packages/server/src/index.ts`.
- Sem mudança de contrato v1 dos session tools (o golden congela o estado
  atual). Consumidores que liam o token do stdout do server standalone
  precisam de `CRAFT_DEBUG_PRINT_TOKEN=1` (nenhum consumidor no repo lia —
  CLI/smoke passam o token via env e só esperam `CRAFT_SERVER_URL`).
