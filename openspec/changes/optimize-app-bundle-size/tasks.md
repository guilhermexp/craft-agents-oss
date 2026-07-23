## 1. Baseline

- [x] 1.1 Registrar tamanho do `.app` atual: `bun run electron:dist:dev:mac` + `du -sh` do `.app` e de `Contents/Resources/app/{vendor,dist,resources}` (baseline = 981 MB)

## 2. T1.1 — uv embarcado uma única vez

- [x] 2.1 Determinar a árvore autoritativa lida em runtime (`main/index.ts:81` lê `resources/bin`; `copy-assets.ts` gera `dist/resources/bin`) e escolher UMA
- [x] 2.2 Ajustar `electron-builder.yml` (`files`) e/ou `copy-assets.ts` para o `uv` não sair nas duas árvores
- [x] 2.3 Verificar no `.app` empacotado que `uv` existe só uma vez e o resolver ainda o encontra

## 3. T1.2 — assets de instalador fora do runtime

- [x] 3.1 `copy-assets.ts` (ou filtro do `electron-builder`) exclui `dmg-background.tiff`, `dmg-background.png`, `dmg-background@2x.png`, `source.png` de `dist/resources`
- [x] 3.2 Confirmar que o `electron-builder` ainda monta o DMG com o background (usa `resources/` como buildResources) e que os assets não estão em `Contents/Resources/app`

## 4. T1.3 — dedup resources/ ↔ dist/resources/

- [x] 4.1 Mapear quais assets embarcam nas duas árvores (bridge-mcp-server, session-mcp-server, tool-icons, docs) e qual o runtime realmente lê
- [x] 4.2 Eliminar a duplicação mantendo a árvore autoritativa; ajustar resolvers se necessário
- [x] 4.3 Verificar no `.app` que cada asset embarca uma vez e o app abre/roda normal

## 5. T2.1 — minify main.cjs + sourcemap out-of-band

- [x] 5.1 `electron-build-main.ts`: esbuild com `minify: true` e `sourcemap` externo
- [x] 5.2 Sourcemap NÃO embarca no `.app` (fica no artefato de build/CI); crash log do main desminificável com ele
- [x] 5.3 Confirmar boot do app empacotado com main minificado (sem regressão funcional)

## 6. T2.2 — Shiki lazy-load

- [x] 6.1 Renderer carrega gramática de linguagem sob demanda (dynamic import) em vez de bundle estático de todas
- [x] 6.2 Confirmar highlight de várias linguagens (comuns + exóticas: cpp, wasm, wolfram) renderizando com cor
- [x] 6.3 Medir redução no bundle inicial do renderer

## 7. T3.1 — playwright on-demand

- [x] 7.1 `bundle-hermes.sh`/`bundle-hermes.ps1` deixam de instalar/embarcar playwright driver no venv
- [x] 7.2 Runtime do bot do Meet baixa o playwright (driver + chromium) no primeiro uso, com feedback de progresso; falha clara se offline no 1º uso
- [x] 7.3 Atualizar `apps/electron/docs/hermes-embed.md` (contrato do runtime vendorizado)
- [ ] 7.4 Validar: bot do Meet inicia do zero (1º uso baixa) e depois funciona; app empacotado sem playwright no `vendor/hermes`

## 8. Track B — profiling RAM/startup

- [x] 8.1 Instrumentar boot: tempo de `loadShellEnv()` síncrono, carga de `theme.json` (2,7 MB), enumeração de workspaces
- [ ] 8.2 Medir heap dos processos vivos (main + renderer + server WS) em idle
- [x] 8.3 Registrar findings; aplicar fixes de baixo risco (ex.: tornar `loadShellEnv` assíncrono/cacheado) que não mudem comportamento
- [x] 8.4 Documentar findings sem fix como follow-up

## 9. Validação (gate de done)

- [x] 9.1 `bun run electron:dist:dev:mac` + `du -sh` do `.app`: comparar com baseline 981 MB e registrar delta real
- [x] 9.2 `bun run validate:ci` verde (typecheck + testes shared/config/doc-tools + i18n parity)
- [ ] 9.3 Smoke real do app empacotado: abre, sessão roda, highlight de código, bot do Meet on-demand
  - [x] Smoke visual (orquestrador via background-computer-use): `.app` empacotado abre e renderiza a UI completa; blocos de código renderizam com highlight colorido (Shiki lazy) — confirmado por screenshot. PENDENTE: sessão interativa completa + join ao vivo no Meet (on-demand) = task 7.4.
- [x] 9.4 `openspec validate optimize-app-bundle-size --strict --no-interactive` verde
