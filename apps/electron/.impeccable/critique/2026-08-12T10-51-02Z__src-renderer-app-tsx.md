---
target: app Electron principal
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-12T10-51-02Z
slug: src-renderer-app-tsx
---
# Impeccable Critique — Craft Agents Electron App Shell

Method: dual-agent (A: DesignAssessment2 · B: DetectorAssessment2)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Rich visual status, but transcript failure can remain an indefinite spinner and dynamic state lacks consistent announcements. |
| 2 | Match System / Real World | 3 | Strong operator vocabulary; mixed-language and technical copy leaks into onboarding and failures. |
| 3 | User Control and Freedom | 3 | Strong close, stop, retry and navigation paths; focusable resize controls do not work from the keyboard. |
| 4 | Consistency and Standards | 3 | Cohesive shell and tokens; one-off colors, sizes and copy fragment critical states. |
| 5 | Error Prevention | 3 | Good destructive confirmation and permission preview; permanent allow scope and truncated commands need stronger safeguards. |
| 6 | Recognition Rather Than Recall | 2 | Text navigation helps, but hover-only disclosure and icon-only secondary actions hide capability. |
| 7 | Flexibility and Efficiency | 3 | Multi-panel, search, multi-select and shortcuts are strong; structural resize remains mouse-only. |
| 8 | Aesthetic and Minimalist Design | 3 | Product-specific, low-chrome composition; open trees and many top-level destinations create avoidable noise. |
| 9 | Error Recovery | 2 | Some retry surfaces are good; transcript, missing-session and empty states often lack a concrete recovery path. |
| 10 | Help and Documentation | 3 | Visible help and docs; onboarding lacks contextual guidance and progress. |
| **Total** | | **28/40** | **Good — solid foundation, accessibility and recovery gaps remain.** |

## Design Specificity Verdict

**LLM assessment:** Strongly authored for Craft Agents. Workspace navigation, session state, parallel conversation panels, contextual preview, permissions and background tasks form a real agent command desk rather than an interchangeable SaaS dashboard. Vision OS gray/cyan has a coherent source contract. The main threat is fragmentation at the edges, not generic composition.

**Deterministic scan:** The exact target `src/renderer/App.tsx` returned zero findings because it is an orchestrator with only eight local class strings. This is not evidence that the rendered shell is clean. A supplementary scan of `src/renderer/components/app-shell/` returned 69 findings: 67 `design-system-font-size` violations, primarily 10px/11px one-offs, plus two raw yellow `design-system-color` findings in `ChatDisplay.tsx:616-617`. `src/renderer/index.html:11` produced two font findings because Inter is loaded but not declared in the normative typography tokens. App.tsx also contains detector-blind spacing (`pt-[48px]`) and its load-error card uses `shadow-minimal`, which receives no Vision OS scenic material override.

**Visual overlays:** No reliable browser overlay is available. Both agents attempted fresh browser-harness tabs, but Chrome access failed before tab creation with `Operation not permitted` on `Google/Chrome/DevToolsActivePort`. Therefore no screenshot, mutation preflight, script injection or visual-console claim is made. Source, static shell and deterministic scans were used as fallback evidence.

## Overall Impression

The shell already has a credible, product-specific operating model and a coherent Vision OS direction. The single biggest opportunity is to make its keyboard-first and resilient-product promises true at the exact moments where users are blocked: resizing, loading failures, first-run setup and empty states.

## What's Working

1. **Authentically operational IA.** The resizable navigation → session list → active work → contextual preview model fits parallel agent work instead of imitating a dashboard.
2. **Agent state is visible and interruptible.** Processing, elapsed time, pending permissions, background work, stop controls and transport retry keep the operator in control.
3. **Vision OS is structural, not decorative.** Gray scenic surfaces, alpha hierarchy, restrained cyan and low-chrome components are encoded as a reusable theme rather than scattered effects.

## Priority Issues

### [P1] Keyboard affordances promise control but do not deliver

**Why it matters:** Resize handles enter the Tab order and announce themselves as separators, but Arrow keys do nothing. The sidebar disclosure nests a focusable `role="button"` inside a button and hides it until hover. This breaks the product's explicit keyboard-first contract and blocks keyboard-only users.

**Fix:** Implement ArrowLeft/ArrowRight resizing, Shift+Arrow coarse steps, `aria-valuenow/min/max` and reset; or remove the controls from Tab until they are operable. Refactor tree rows to valid `treeitem`/`aria-expanded` semantics or sibling link/toggle controls, visible on focus as well as hover.

**Suggested command:** `$impeccable audit`

### [P1] Transcript loading failure can become an infinite spinner

**Why it matters:** `messagesLoadError`, retry state and callback exist, but the rendered branch only shows loading. Users cannot distinguish waiting from failure or recover safely.

**Fix:** Propagate the loader error into `ChatPage`; replace failed loading with `role="alert"`, plain-language cause, Retry and a safe exit while preserving any loaded transcript and draft. Announce retry through a restrained live region.

**Suggested command:** `$impeccable harden`

### [P1] First-run setup asks for expertise before demonstrating value

**Why it matters:** Six providers appear at equal weight, advanced local/API concepts mix with subscriptions, selection advances immediately, copy mixes languages and there is no progress indicator. First-timers can abandon before reaching the product's core value.

**Fix:** Lead with two or three recommended access paths, place Hermes/API/local under advanced setup, add step progress and confirmation, localize every string, and keep Setup later as an explicit escape.

**Suggested command:** `$impeccable onboard`

### [P2] Critical states escape tokens, typography and localization

**Why it matters:** Hardcoded amber/blue/cyan/yellow and 10px/11px type create a second visual dialect in transport, permissions, Hermes/search and chat highlights. Hardcoded accessible names and status text also break the eight-locale product promise. Visual-only state is weak for screen readers.

**Fix:** Replace raw colors with accent/info/success/destructive and tonal derivatives; either add deliberate compact typography tokens or move one-offs onto the existing scale; localize visible and accessible copy; add non-repeating `status`/`alert` announcements.

**Suggested command:** `$impeccable polish`

### [P2] Empty and error states stop momentum

**Why it matters:** Missing sources, skills, automations, stale sessions and global errors often describe a condition without one safe next action. Failures become the remembered end of the journey.

**Fix:** Give every state one contextual primary action—Add source, Add skill, Create automation, Back to sessions/New session—and keep technical details collapsed and copyable.

**Suggested command:** `$impeccable harden`

## Persona Red Flags

**Alex (Power User):** Resize handles receive focus but do not resize; structural actions still depend on hover/context-menu discovery. Multi-panel, search, shortcuts and multi-select are otherwise strong.

**Sam (Accessibility-Dependent):** Nested interactive navigation semantics are invalid; separators are announced but keyboard-inert; processing/loading/transport changes lack consistent live-region treatment; some accessible names remain English-only.

**Jordan (First-Timer):** Six equal provider choices, specialized terms, mixed-language copy and no progress indicator front-load complexity. Empty states and technical raw errors do not teach a safe next step.

## Minor Observations

- `TooltipProvider delayDuration={0}` fits dense desktop work but cannot replace persistent labels or semantics.
- Some 26px topbar controls are appropriate for pointer desktop use but too small if the compact surface is expected to be touch-capable.
- Sidebar ambient counts hidden until hover weaken at-a-glance command-desk awareness.
- Permission command previews truncate without a Show full command path.
- Base-theme comments still mention purple/amber although Vision OS cyan/sky is now normative.
- Real contrast, zoom 200%, truncation, responsive geometry and reduced-motion behavior remain unverified without a browser screenshot path.

## Questions to Consider

- What if onboarding asked how the user already accesses a model, then revealed only the relevant provider path?
- Should a focusable resize handle exist before it can actually resize by keyboard?
- Which three destinations own 80% of daily use, and why do the other destinations compete at the same level immediately?
- Can every failure end with one safe action instead of only an explanation?
- Should Always Allow expose its scope and the full command before committing?
