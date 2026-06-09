# Audit Report — craft-agents-oss (foco React)

**Data:** 2026-06-09
**Auditor:** Claude (skill project-audit, `--focus react`)
**Escopo:** `apps/electron/src/renderer`, `apps/webui`, `apps/viewer`, `packages/ui`
**Stack detectada:** React (SPA Electron + Vite) + Architecture
**Score React:** ~88% (saudável; débitos concentrados em tamanho de arquivo e disciplina de hooks)

## Discovery

- **Linguagem:** TypeScript (strict, sem path plain-JS)
- **Framework:** React 18.3.1 (SPA, sem Next) + Vite 8 + esbuild
- **Build tooling:** `@vitejs/plugin-react` ^6.0.1, TypeScript ^6.0.2 — todos na ponta da release; **não** marcar como desatualizado
- **UI:** Radix UI + shadcn/ui, Tailwind **v4.2.2** (`@theme inline`, sem `tailwind.config`, sem `@apply` ✓)
- **Editor/Markdown:** TipTap 3.22, react-markdown 10 + remark-gfm/math + rehype-katex, Shiki
- **State:** Jotai 2.19 (+ jotai-family) — sem Redux/Zustand
- **Data fetching:** **manual via IPC `window.electronAPI` dentro de useEffect** — sem TanStack Query
- **i18n:** react-i18next 17 (paridade de chaves enforçada por lint)
- **Testes:** Bun test (suite existe no repo; não rodada full neste audit)
- **Monorepo:** workspaces Bun (`apps/*`, `packages/*`)
- **LOC React:** ~129.000 em ~660 arquivos
  - renderer: 96.486 LOC / 465 arq · ui: 31.409 LOC / 180 arq · webui: 818 · viewer: 652

### God files (>500 LOC): **50 arquivos** · (>1000 LOC): **14 arquivos**

| Arquivo | LOC |
|---|---|
| `renderer/components/app-shell/AppShell.tsx` | 3982 |
| `ui/src/components/chat/TurnCard.tsx` | 3253 |
| `renderer/components/app-shell/input/FreeFormInput.tsx` | 2665 |
| `renderer/components/app-shell/ChatDisplay.tsx` | 2396 |
| `renderer/App.tsx` | 2165 |
| `renderer/contexts/NavigationContext.tsx` | 1310 |
| `ui/src/components/chat/turn-utils.ts` | 1179 |
| `renderer/components/ui/EditPopover.tsx` | 1142 |
| `renderer/pages/settings/AiSettingsPage.tsx` | 1082 |
| `ui/src/components/markdown/Markdown.tsx` | 991 |

(`playground/registry/*` também aparece grande, mas é mock/dev — prioridade baixa.)

## Build Verification

- **tsc (`typecheck:electron`, cobre renderer):** ✅ PASS — 0 erros
- **`@ts-ignore` / `@ts-expect-error`:** 2 ocorrências (renderer+ui)
- **lint / test full:** não executados neste audit (repo grande; rodar `bun run validate:dev` separado)

## Findings

### CRÍTICO
- **Nenhum.** Sem rota de XSS explorável, sem `any` desenfreado, sem conditional-falsy, type-check limpo.

### ALERTA (deveriam ser corrigidos)
- [ ] **14 god files >1000 LOC**, 4 deles >2300. `AppShell.tsx` (3982) acumula filtros + resize de 3 painéis + 5 modais + handlers IPC + render da shell (158 hooks no arquivo). `TurnCard.tsx` (3253) mistura árvore de atividades + anotações + todo-list + ResponseCard. — `AppShell.tsx`, `TurnCard.tsx`, `FreeFormInput.tsx`, `ChatDisplay.tsx`, `App.tsx`
- [ ] **Data fetching manual em useEffect sem AbortController/cache** (~67–84 ocorrências). Padrão `isMounted`/`cancelled` flag (legacy) sem dedup; risco de race condition quando deps mudam rápido. — ex: `renderer/pages/SkillInfoPage.tsx:42`, `renderer/pages/SourceInfoPage.tsx`, `ui/src/components/overlay/ImagePreviewOverlay.tsx:90`
- [ ] **~40–50 useEffect derivando estado** que deveria ser `useMemo`/cálculo no render. — ex: `ImagePreviewOverlay.tsx:77` (`setActiveIdx`), `SourceInfoPage.tsx` (`setMcpTools`)

### INFO (melhorias opcionais)
- [ ] **117 `console.log`** deixados no renderer (não warn/error). Trocar por logger ou remover. — `apps/electron/src/renderer/**`
- [ ] **React.memo subutilizado (7)** vs 14 god files que re-renderizam árvores grandes. Avaliar memo em `MessageBubble`/`ActivityRow` ao extraí-los. (useMemo já bem usado: 359)
- [ ] **`entity-icon.tsx:120,128`** injeta `icon.rawSvg` via `dangerouslySetInnerHTML`; sanitização é regex (`sanitizeSvgForInline`, `icon-cache.ts:709`) que remove `<script>`/`on*`/`javascript:` mas **não** cobre `data:` URIs nem `xlink:href`. Origem é workspace local (confiável) → risco BAIXO; considerar DOMPurify se SVG puder vir de fonte remota.
- [ ] **11 `eslint-disable react-hooks/exhaustive-deps`** sem comentário justificando. — ex: `ChatPage.tsx:145`, `ThemeContext.tsx:162`, `useEntityListInteractions.ts:131`

## Métricas por Categoria

| Categoria | Resultado |
|---|---|
| Type safety (`any`/`as any`) | ✅ 11 + 30 em 129k LOC — excelente |
| Conditional rendering falsy (`{n && <C/>}`) | ✅ 0 |
| Barrel imports | ✅ 0 |
| Tailwind v4 (`@apply`, config) | ✅ limpo |
| a11y (`<img>` sem `alt`) | ✅ 0 |
| XSS (`dangerouslySetInnerHTML`) | ✅ fontes confiáveis (Shiki/mermaid/excalidraw); 1 ponto BAIXO |
| Tamanho de arquivo | ⚠️ 14 >1000 LOC |
| Disciplina de hooks (useEffect) | ⚠️ ~90 de 559 problemáticos |

## Plano de Ação

| # | Finding | Severidade | Esforço | Ação |
|---|---|---|---|---|
| 1 | Quebrar `AppShell.tsx` | ALERTA | G | extrair `useSessionListFilters()`, `useMultiPanelResize()`, `<ModalStack/>` |
| 2 | Quebrar `TurnCard.tsx` | ALERTA | G | extrair `<ActivityTreeView/>`, `<TodoSection/>`, `<ResponsePanel/>` |
| 3 | AbortController + custom `useQuery` hook nos fetches em useEffect | ALERTA | M | padronizar 1 hook de fetch com cancelamento/cache leve |
| 4 | Converter useEffect-derivação → useMemo | ALERTA | P | ~40 pontos, mecânico |
| 5 | Remover/trocar `console.log` | INFO | P | logger ou drop |
| 6 | Documentar/remover `eslint-disable exhaustive-deps` | INFO | P | 11 pontos |
| 7 | Dupla sanitização SVG (DOMPurify) em entity-icon | INFO | P | só se ícone remoto for possível |

## Parecer

Base React **sólida e bem disciplinada** nos fundamentos que costumam quebrar: zero conditional-falsy, zero barrel imports, Tailwind v4 corretíssimo, type-check limpo e uso de `any` mínimo para 129k LOC. Não há nada crítico. O débito real é **estrutural**: um punhado de god files (AppShell, TurnCard, FreeFormInput, ChatDisplay) que concentram estado + render + IPC e dificultam teste e navegação — exatamente o alvo de extração para hooks/sub-componentes. O segundo eixo é **disciplina de hooks**: ~90 dos 559 useEffect merecem revisão (derivação de estado → useMemo; fetch manual → AbortController + cache leve), agravado pela ausência de uma camada de data-fetching (sem TanStack Query, tudo é IPC à mão). Próximo passo recomendado: atacar #1 e #2 (maior ganho de manutenibilidade) e padronizar um `useQuery` IPC para zerar a classe de race conditions de #3.
