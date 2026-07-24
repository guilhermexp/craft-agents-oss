# Tasks — upgrade-pi-computer-use-v0-5

## F1 — Contrato e regressões

**must_haves:** change válida; nomes v0.5 congelados; comportamento desabilitado e composição com `pi-better-subagents` cobertos antes da implementação.

- [ ] **1.1 Validar contrato OpenSpec**
  - files: `openspec/changes/upgrade-pi-computer-use-v0-5/**`
  - verify: `openspec validate upgrade-pi-computer-use-v0-5 --strict --no-interactive`
- [ ] **1.2 Escrever testes RED da allowlist v0.5 e remoção dos tools legados**
  - files: `packages/pi-agent-server/src/session-tool-registration.test.ts`, `packages/pi-agent-server/src/computer-use-tools.ts`
  - verify: `bun test packages/pi-agent-server/src/session-tool-registration.test.ts`
- [ ] **1.3 Escrever testes RED do loader conjunto e do pacote ausente**
  - files: testes focados em `packages/pi-agent-server/src/`
  - verify: `bun test packages/pi-agent-server/src/*computer-use*.test.ts packages/pi-agent-server/src/session-tool-registration.test.ts`
- [ ] **1.4 Escrever teste RED de packaging para as duas extensões e arquivos sentinela v0.5**
  - files: `packages/shared/src/__tests__/interceptor-packaging-contract.test.ts` ou teste de build equivalente
  - verify: `bun test packages/shared/src/__tests__/interceptor-packaging-contract.test.ts`

## F2 — Vendorizado, allowlist e runtime

**must_haves:** upstream pinado; overlay Craft explícito; somente 11 tools v0.5; carregamento macOS Pi-only; recurso isolado do checkout.

- [ ] **2.1 Sincronizar `src/pi-computer-use` com o commit fixado e registrar provenance/overlay**
  - files: `packages/pi-agent-server/src/pi-computer-use/**`
  - verify: `test "$(tr -d '\n' < packages/pi-agent-server/src/pi-computer-use/UPSTREAM_COMMIT)" = "8e1772f317dedd3a77d34835c970d92cd5b887ae"`
- [ ] **2.2 Reescrever a skill Craft para o protocolo v0.5**
  - files: `packages/pi-agent-server/src/pi-computer-use/skills/computer-use/SKILL.md`
  - verify: `! grep -E '\b(screenshot|computer_actions|set_text|double_click)\b' packages/pi-agent-server/src/pi-computer-use/skills/computer-use/SKILL.md`
- [ ] **2.3 Migrar allowlist e integrar no resource loader único sem regredir subagents**
  - files: `packages/pi-agent-server/src/computer-use-tools.ts`, `packages/pi-agent-server/src/index.ts`
  - verify: `bun test packages/pi-agent-server/src/session-tool-registration.test.ts packages/pi-agent-server/src/*computer-use*.test.ts`
- [ ] **2.4 Tornar o carregamento runtime autossuficiente fora do checkout**
  - files: `packages/pi-agent-server/package.json`, `packages/pi-agent-server/tsconfig.typecheck.json`, build/testes relacionados
  - verify: teste isolado definido em F1 inicia/carrega a extensão sem resolver o `node_modules` raiz

## F3 — Build e distribuição Electron

**must_haves:** `dist/pi-computer-use` completo; copy de recurso preserva subagents; `.app` contém package, extensão, helper/setup e skill.

- [ ] **3.1 Materializar o vendorizado v0.5 no build do Pi server**
  - files: `packages/pi-agent-server/package.json`, scripts locais necessários
  - verify: `cd packages/pi-agent-server && bun run build && test -f dist/pi-computer-use/package.json`
- [ ] **3.2 Copiar `pi-computer-use` inteiro em `copyPiAgentServer()` preservando o bloco subagents**
  - files: `scripts/build/common.ts`
  - verify: teste de packaging da F1 verde
- [ ] **3.3 Gerar recursos Electron e inspecionar arquivos sentinela no destino**
  - files: artefatos de build não commitados; `apps/electron/electron-builder.yml` apenas se indispensável
  - verify: `bun run electron:build:resources && test -f apps/electron/dist/resources/pi-agent-server/pi-computer-use/package.json`

## F4 — Gates e smoke real

**must_haves:** testes/typecheck/OpenSpec verdes; helper autorizado; observação real não preta; ação temporária confirmada; nenhuma alegação não provada.

- [ ] **4.1 Rodar gates focados e gerais aplicáveis**
  - files: nenhum arquivo novo esperado
  - verify: `cd packages/pi-agent-server && bun run validate`
  - verify: `bun run typecheck:all`
  - verify: `bun run lint:tool-contracts`
  - verify: `openspec validate upgrade-pi-computer-use-v0-5 --strict --no-interactive`
- [ ] **4.2 Instalar/atualizar `~/Applications/pi-computer-use.app` e obter TCC**
  - files: helper instalado fora do repo
  - verify: helper existe no path estável e Accessibility + Screen Recording estão concedidos pelo usuário
- [ ] **4.3 Validar no Craft empacotado/real com TextEdit temporário**
  - files: evidência de smoke em artefato da change, sem salvar documento TextEdit
  - verify: `find_roots` + `observe_ui` retornam estado real/imagem não preta; `act_ui` insere marcador; nova observação confirma; documento fecha sem salvar
- [ ] **4.4 DOX pass e review final**
  - files: cadeia `AGENTS.md` raiz→alvo somente se o contrato local mudou
  - verify: documentação não cita API legada e `openspec validate upgrade-pi-computer-use-v0-5 --strict --no-interactive` permanece verde

## Boundary Map

- F1 pode tocar apenas OpenSpec e testes de caracterização.
- F2 pode tocar apenas `packages/pi-agent-server` e não pode editar overflow recovery ou implementação de `pi-better-subagents`.
- F3 pode tocar build/packaging; `electron-builder.yml` exige evidência de que o recurso atual não basta.
- F4 não adiciona feature; corrige somente regressões causadas pela change ou reporta bloqueio.
