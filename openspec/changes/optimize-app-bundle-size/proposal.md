## Why

O `.app` empacotado (macOS arm64) pesa **981 MB**. Medição do bundle mostra
peso concentrado em desperdício e em assets carregados de forma não-preguiçosa,
**sem que nenhuma funcionalidade dependa disso**:

- `uv` (42 MB) embarca **duas vezes** — `app/resources/bin` e
  `app/dist/resources/bin` — porque `copy-assets.ts` espelha `resources/` em
  `dist/resources/` e o `electron-builder` inclui as duas árvores. O runtime lê
  só uma (`main/index.ts:81`).
- Assets de instalador/DMG (`dmg-background.tiff` 12 MB + pngs + `source.png`,
  ~13,5 MB) são copiados para `dist/resources` e embarcam dentro do runtime,
  onde o app nunca os usa (só o `electron-builder` precisa deles como
  `buildResources` para montar o DMG).
- `resources/` e `dist/resources/` coexistem no pacote (43 MB + 80 MB) com
  bridge/session-mcp, tool-icons e docs duplicados.
- `dist/main.cjs` (51 MB) ship **não minificado** (1,25M linhas legíveis).
- O highlight de código (Shiki) embarca **todas** as gramáticas no bundle
  inicial do renderer (emacs-lisp, wolfram, angular-ts, cpp, wasm…).
- O driver do playwright (115 MB — um Node.js inteiro dentro do venv Python)
  embarca sempre, mas só é usado pelo bot do Google Meet
  (`bundle-hermes.sh:232-233`).

Nenhum backend ou feature é removido — todos (Claude, Pi, Hermes, bot do Meet,
messaging) permanecem. O ganho vem de dedup, minify, lazy-load e on-demand.

## What Changes

- **T1.1** — `uv` embarca **uma única vez**. A árvore autoritativa lida pelo
  runtime é preservada; a cópia redundante deixa de ser empacotada. (−42 MB)
- **T1.2** — Assets de instalador/DMG (`dmg-background.*`, `source.png`) NÃO
  embarcam no runtime; seguem disponíveis para o `electron-builder` como
  `buildResources`. (−13,5 MB)
- **T1.3** — `resources/` e `dist/resources/` deixam de duplicar
  bridge-mcp-server, session-mcp-server, tool-icons e docs no pacote; uma
  árvore autoritativa por asset. (−10 a 25 MB)
- **T2.1** — `dist/main.cjs` é minificado (esbuild `minify:true`) com sourcemap
  **out-of-band** (gerado no artefato de build/CI, não embarcado no `.app`),
  permitindo desminificar crash logs do processo principal. (−20 a 30 MB)
- **T2.2** — Shiki carrega gramáticas **sob demanda** (lazy) em vez de embarcar
  todas no bundle inicial. Toda linguagem continua com highlight. (bundle +
  startup)
- **T3.1** — O driver do playwright deixa de ser embarcado; é baixado
  **on-demand** no primeiro uso do bot do Meet. O bot continua funcionando; só
  o primeiro uso passa a exigir rede. (−115 MB)
- **B (profiling)** — Pass de RAM/startup: instrumentar `loadShellEnv()`
  síncrono no boot, carga de `theme.json` (2,7 MB) no start, enumeração de
  workspaces no boot, e heap dos processos vivos. Findings viram fixes na mesma
  change.

Total de disco estimado: **~205-245 MB → `.app` de 981 MB para ~740-775 MB**
(Electron/Chromium ~255 MB é piso).

- **Não-objetivo**: remover qualquer backend de agente (Claude/Pi/Hermes todos
  usados); podar SDKs de messaging (discord/telegram/slack — usados); alterar
  `asar: false` (decisão consciente de startup); tocar o piso Electron/Chromium.
