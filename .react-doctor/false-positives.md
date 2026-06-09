# React Doctor — false positives e regras triadas (2026-06-09)

Triagem completa do backlog inicial (1528 diagnostics dedup). ~750 corrigidos em código
ao longo de 4 fases (typecheck:all verde após cada onda). O que segue documenta por que
as regras restantes estão desligadas/rebaixadas em `doctor.config.json` — cada uma foi
avaliada caso a caso por agentes lendo o código, não desligada às cegas.

## Dead code (deslop)

- `deslop/unused-file` — FPs sistemáticos: `apps/electron/eslint-rules/*.cjs` (carregadas
  pelo ESLint por nome), `apps/electron/src/main/shims/*.cjs` (referenciadas pelo bundler),
  `resources/` (vendored). Os demais ~65 arquivos src podem ser órfãos do refactor
  `refactor/architecture-deepening`, mas deleção exige revisão humana (dynamic import/lazy).
  Lista de candidatos: rodar `npx react-doctor --json | jq '...unused-file...'`.
- `deslop/unused-export` — residuais são re-exports via barrel (`settings/index.ts`,
  `onboarding/index.ts`, `memory/index.ts`, `actions/index.ts`…) que o deslop não rastreia.
  ~150 exports genuinamente mortos JÁ foram removidos (verificação grep repo-wide antes
  de cada remoção).

## State & effects — residuais são FP ou padrão intencional

- `no-adjust-state-on-prop-change` (era a regra dominante, 278→83): os residuais são
  (a) setters síncronos de setup/cleanup em effects cujo corpo principal é async (IPC/fetch)
  — a própria validation prompt da regra os exclui; (b) optimistic-UI e edit-buffers
  intencionais (CronBuilder, label-value-popover, CompactPermissionModeSelector);
  (c) máquinas de animação RAF/timer (Island). ~60 casos reais foram corrigidos com o
  padrão discriminador.
- `no-event-handler` — quase 100% FP aqui: effects que reagem a eventos EXTERNOS
  (IPC `window.electronAPI.on*`, subscriptions, props vindas do main process), onde não
  existe handler local para onde mover a lógica.
- `exhaustive-deps` — residuais: deps de sub-campos intencionais (otimização), métodos de
  `ref.current` (não-reativos), supressões eslint existentes documentadas. O ESLint do
  repo já roda `react-hooks/exhaustive-deps`.
- `no-derived-state*`, `no-cascading-set-state`, `no-chain-state-updates`,
  `no-mirror-prop-effect`, `no-effect-chain`, `rerender-state-only-in-handlers`,
  `no-pass-data-to-parent`, `no-prop-callback-in-effect`, `no-pass-live-state-to-parent` —
  residuais exigem refactor cross-file (useReducer em fluxos async com cancelamento,
  TanStack-Table patterns, DOM measurement) com risco comportamental > benefício.

## Arquiteturais (design) — trabalho dedicado, não lint

- `no-giant-component`, `no-multi-comp`, `prefer-useReducer`, `no-many-boolean-props`,
  `only-export-components`, `no-render-in-render` (residuais com 9+ props closured),
  `circular-dependency` — alvo correto é o refactor de god components já mapeado em
  `.planning/AUDIT.md` (AppShell 3982 LOC, TurnCard 3253 LOC…), não fixes pontuais.

## FPs pontuais comprovados (regra desligada quando só restou FP)

- `js-set-map-lookups` — `.includes()/.indexOf()` em RECEIVERS STRING (a regra é p/ arrays).
- `no-array-index-as-key` — listas append-only (terminal/ANSI spans) e menus estáticos sem id.
- `prefer-tag-over-role` — resize handles com children/handlers (≠ `<hr>` void),
  contentEditable `role=textbox` (≠ `<input>`), triggers ReactNode (nested-button risk).
- `no-static-element-interactions` — drag/pan canvases, backdrops de dismissal,
  selection-catchers, divs com role condicional já correto.
- `async-await-in-loop` — loops sequenciais POR DESIGN (retry com delay, ordem de inserção
  no editor, read-modify-write em arquivo, confirmação gating).
- `no-danger` — `dangerouslySetInnerHTML` com fontes confiáveis (Shiki, mermaid render,
  excalidraw SVG sintetizado, ícones de workspace sanitizados) — auditado em `.planning/AUDIT.md`.
- `use-lazy-motion` — residuais exigem LazyMotion provider em árvore cross-file.
- `no-autofocus` — inputs de popover/rename abertos por ação explícita do usuário.
- `no-initialize-state` — medições de DOM via ResizeObserver (ref é null no init).
- `rendering-hydration-mismatch-time` — app Electron (sem SSR) e `Date.now()` em callbacks.
- `client-passive-event-listeners` — handlers que chamam `preventDefault()` (scroll-lock).
- `rerender-lazy-ref-init` — residuais exigem null-narrowing invasivo p/ ganho desprezível.
- `jsx-no-jsx-as-prop` / `no-inline-exhaustive-style` — residuais com closures de loop ou
  valores de animação dinâmicos.

## Como reativar

Qualquer regra pode voltar com `npx react-doctor rules enable <rule>` quando o time for
atacar aquela classe (ex: reativar `no-giant-component` durante o refactor do AppShell).
