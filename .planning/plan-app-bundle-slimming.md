# Plan — App Bundle Slimming (craft-agents-oss)

Data: 2026-07-23
Objetivo: deixar o `.app` mais leve (disco + startup + RAM) **sem perder nenhuma funcionalidade**. Todas as features permanecem (Claude + Pi + Hermes + Meet bot + messaging). Nada é removido por "não-uso" — só dedup, minify, lazy-load e on-demand.

## Baseline medido

`.app` (macOS arm64) = **981 MB**. Composição:

| Camada | MB | Nota |
|---|---|---|
| Frameworks/ (Electron+Chromium) | 255 | Piso — não reduzível sem trocar shell |
| vendor/hermes | 345 | playwright driver 115 + python 55 + venv site-packages ~80 + hermes-agent 45 |
| vendor/bun | 57 | Runtime de subprocesso — necessário |
| dist/main.cjs | 51 | Não minificado (1,25M linhas legíveis) |
| dist/resources | 58 | uv 42 + dmg-background 13,5 + resto |
| resources/ | 43 | Duplica dist/resources (uv 2ª cópia) |
| dist/renderer (js) | ~21 | Shiki embarca todas as gramáticas |

## Escopo decidido (1 change OpenSpec, tudo junto)

### Track A — Disco / startup

| # | Ação | Preserva feature via | Ganho | Risco |
|---|---|---|---|---|
| T1.1 | Parar de embarcar `uv` 2× (`resources/bin` + `dist/resources/bin`) | 1 árvore autoritativa; runtime resolve em `main/index.ts:81` | −42 MB | Zero |
| T1.2 | Tirar assets de DMG/installer de dentro do runtime (`dmg-background.tiff` 12 MB + pngs + `source.png`) | ficam só como buildResources do electron-builder | −13,5 MB | Zero |
| T1.3 | Dedup `resources/` ↔ `dist/resources/` (bridge/session-mcp, tool-icons, docs) | manter a árvore que o runtime lê (`copy-assets.ts` gera `dist/resources`) | −10-25 MB | Baixo |
| T2.1 | Minificar `main.cjs` | esbuild `minify:true` + sourcemap **out-of-band** (fica no artefato de build/CI, desminifica crash log) | −20-30 MB | Baixo |
| T2.2 | Shiki: parar de embarcar toda gramática no bundle inicial | lazy-load de gramática sob demanda (toda linguagem continua com highlight) | bundle+startup | Baixo |
| T3.1 | Playwright driver (115 MB, só p/ bot do Meet) | on-demand: baixa no 1º uso do Meet (`bundle-hermes.sh:232-233` deixa de embarcar) | −115 MB | Médio (contrato Hermes) |

**Total disco: ~205-245 MB → `.app` de 981 MB para ~740-775 MB.**

### Track B — RAM / startup (profiling, mesma change)

Backends já sobem sob demanda (spawn por sessão), então não há subprocesso ocioso óbvio. Profiling read-only pra achar wins:

- `loadShellEnv()` síncrono no boot (`execSync` do login shell) — mover pra assíncrono/cache
- `theme.json` de 2,7 MB carregado no start
- enumeração de 234 workspaces no boot
- heap dos processos vivos (main + renderer + server WS)

Findings → fixes na mesma change.

## Não-objetivos (explícitos)

- **Não** remover backend algum (Claude/Pi/Hermes todos usados).
- **Não** podar SDKs de messaging (discord/telegram/slack) — messaging é usado.
- **Não** mexer em `asar: false` (decisão consciente de startup do projeto).
- **Não** tocar o piso do Electron/Chromium (Frameworks 255 MB).

## Validação real (gate de done)

- Buildar o `.app` antes e depois: `bun run electron:dist:dev:mac`.
- Medir `du -sh` do `.app` e comparar com o baseline (981 MB).
- Bot do Meet: abrir 1× e confirmar download on-demand do playwright + funcionamento.
- Highlight de código: renderizar blocos de várias linguagens e confirmar cor (lazy-load).
- `bun run validate:ci` verde (typecheck + testes shared/config + i18n parity).
- Crash-log do main desminificável com o sourcemap out-of-band.

## Execução

- Spec authoring (OpenSpec change) feito pelo orquestrador.
- Implementação por worker CLI no repo (não no orquestrador), com a validação real acima.
- **Bloqueio pré-fanout:** worktree sujo na `main` com trabalho de Hermes não-commitado (`hermes-agent.ts`, `App.tsx`, `ChatDisplay.tsx`, change `expose-hermes-craft-mcp-tools`). Resolver isolamento antes de soltar worker (worktree dedicado vs commit/stash do WIP). Arquivos do plano NÃO colidem com os arquivos sujos (build-config vs Hermes), mas checkpoint-antes-do-fanout exige decisão explícita.
