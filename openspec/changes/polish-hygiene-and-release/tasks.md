## 1. F6.1 — Release parcial nunca silenciosa

- [x] 1.1 Job `finalize` em `release.yml` (`needs: build`, `if: always()`) que localiza a draft da tag, confere assets contra {macOS arm64 dmg, macOS x64 dmg, Windows exe} e marca nome+corpo com "⚠️ INCOMPLETE — missing: …" quando faltar plataforma; limpa a marca quando completo
- [x] 1.2 Validar YAML (actionlint se disponível, senão revisão manual de sintaxe)
- [x] 1.3 Delta na spec `release` descrevendo o comportamento de release parcial sinalizada

## 2. F6.2 — Spec meetings fiel ao contexto do bot

- [x] 2.1 Investigar o payload real do bot (pm.start: url, guest_name, mode, auth_state) e o lado Craft (record/summary com link+título)
- [x] 2.2 MODIFIED requirement "Bot recebe contexto da reunião" com cenário novo asserindo o payload do bot e sem prometer participantes/agenda não implementados

## 3. F6.3 — HERMES_SRC não vaza no fluxo Update

- [x] 3.1 `update-hermes-runtime.sh` descarta `HERMES_SRC` herdado (unset + aviso), salvo `HERMES_ALLOW_SRC_OVERRIDE=1` explícito

## 4. F6.4 — Golden file do contrato v1

- [x] 4.1 Gerar `scripts/session-tool-contracts.golden.json` (28 tools, JSON estável via stableJson)
- [x] 4.2 Checker compara catálogo corrente contra o golden e falha em qualquer drift; flag `--update` regenera explicitamente
- [x] 4.3 `bun run lint:tool-contracts` verde com o golden committed

## 5. F6.5 — Quit mata agents ACP

- [x] 5.1 `SessionManager.cleanup()` chama `managed.agent?.destroy()` para toda sessão com agent ativo (com try/catch por sessão)
- [x] 5.2 Reaper de startup (`cleanupHermesDashboardOrphans`) também mata órfãos `-m acp_adapter` do python vendorizado
- [x] 5.3 Teste: cleanup chama destroy nos agents ativos

## 6. F6.6 — hostRuntime nos serviços de meetings

- [x] 6.1 Helper de host runtime context em `apps/electron/src/main/meetings/` (mesmo shape de `createElectronPlatform`)
- [x] 6.2 `meeting-summary-service.ts` e `meeting-video-analysis-service.ts` passam o 3º arg em `createBackendFromConnection`; typecheck limpo; testes de meetings seguem verdes (baseline 17 pass)

## 7. F6.7 — Async twins de console/network/resize

- [x] 7.1 `getConsoleLogsAsync`/`getNetworkLogsAsync`/`windowResizeAsync` na `IBrowserPaneManager` + implementações (local wrap sync, Null, Remote aguardando o invoke WS)
- [x] 7.2 Callbacks `getConsoleLogs`/`windowResize`/`getNetworkLogs` do SessionManager usam as versões async
- [x] 7.3 Teste: no modo remoto os 3 retornam o resultado real do invoke; doc `embedded-browser-cdp-replication.md` alinhado se necessário

## 8. F6.8 — Bearer fora do stdout

- [x] 8.1 `packages/server/src/index.ts` só ecoa `CRAFT_SERVER_TOKEN=` com `CRAFT_DEBUG_PRINT_TOKEN=1` (token é sempre fornecido pelo operador via env)
- [x] 8.2 Electron headless grava o token em arquivo `0600` e imprime `CRAFT_SERVER_TOKEN_FILE=<path>`; raw print só com `CRAFT_DEBUG_PRINT_TOKEN=1`

## 9. Validação

- [x] 9.1 `HOME=/tmp/craft-worker-home bun run validate:ci` exit 0
- [x] 9.2 `bun run lint:tool-contracts` verde
- [x] 9.3 Baselines: meetings 17 pass, browser-pane ≤8 fails, i18n parity OK
- [x] 9.4 `openspec validate polish-hygiene-and-release --strict --no-interactive` verde
