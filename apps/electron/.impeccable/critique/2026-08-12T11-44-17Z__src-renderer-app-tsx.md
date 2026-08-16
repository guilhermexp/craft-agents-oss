---
target: app Electron principal
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-12T11-44-17Z
slug: src-renderer-app-tsx
---
# Impeccable Critique — Craft Agents Electron App Shell

Method: dual-agent (A: DesignReassessment · B: DetectorReassessment)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Progress, transport, loading and retry are visible; some errors lack live announcements. |
| 2 | Match System / Real World | 2 | ACP, Hermes, Ollama and provider trade-offs remain unexplained. |
| 3 | User Control and Freedom | 3 | Back, skip and retry exist; provider selection advances immediately. |
| 4 | Consistency and Standards | 3 | Components cohere, but default violet conflicts with the documented cyan contract. |
| 5 | Error Prevention | 3 | Validation and confirmations exist; provider choice has weak consequence framing. |
| 6 | Recognition Rather Than Recall | 3 | Context remains visible, but narrow composers expose too many defaults. |
| 7 | Flexibility and Efficiency | 3 | Strong keyboard shell; onboarding and composer lack progressive expert paths. |
| 8 | Aesthetic and Minimalist Design | 2 | Calm design, but provider and composer density flatten hierarchy. |
| 9 | Error Recovery | 3 | Transcript/session retry improved; provider error lacks alert semantics and contextual recovery. |
| 10 | Help and Documentation | 2 | Global docs exist; provider choice lacks contextual help. |
| **Total** | | **27/40** | **Acceptable — solid structure, material UX gaps remain.** |

## Design Specificity Verdict

**LLM assessment:** Structurally specific, visually and verbally only moderately specific. Sessions, runtimes, sources, permissions and parallel work clearly form a Craft Agents command surface. The onboarding still resembles a generic dark AI workspace: repeated welcome copy, six undifferentiated technical choices and violet emphasis without an explicit product thesis.

**Deterministic scan:** 285 static findings across 644 renderer files: 220 font-size, 51 color, 5 radius, 4 overused-font, 4 design-system-font and 1 border-accent-on-rounded. About 136 are probable noise or non-product fixtures: 88 playground, 12 PerfOverlay, 5 color-picker data, 8 Inter duplicates, and 9 14px sidecar contradictions. The actionable product signal is about 149 findings, overwhelmingly 10px/11px typography. App-shell improved from 69 to 67 findings and now has zero raw-color findings; the two raw yellow search highlights were removed.

**Visual evidence:** Assessment A inspected the playground in a fresh tab at 968×1080 with 800×600 previews. Assessment B could not reach the host from its isolated network, so no detector overlay was injected. No user-visible overlay is claimed.

## Overall Impression

The pass fixed real reliability and accessibility gaps and made Vision OS coherent at the token level. The biggest remaining opportunity is adaptive hierarchy: narrow onboarding and composer compositions expose too many decisions while losing the framing users need to make them.

## What's Working

1. **Responsible state architecture.** Loading, reauth, onboarding, workspace choice, degraded transport and retry are distinct states rather than ambiguous emptiness.
2. **Product-specific operational shell.** Multi-panel sessions, context, permissions and agent runtimes read as a command surface, not a generic dashboard.
3. **Improved feedback and semantics.** The onboarding progressbar, transcript retry, keyboard resize and dynamic announcements address prior P1 gaps.

## Priority Issues

### [P1] Provider selection loses context in constrained containers
- **Why it matters:** At the measured 800×600 preview, the title/question sat above the scroll viewport while Local model and Set up later were below it. Users scroll through the hardest decision without its framing.
- **Fix:** Make the wizard main own overflow, align overflowing content to the start, keep the question visible, compact cards in narrow containers, and test 448px plus 800×600.
- **Suggested command:** `$impeccable adapt`

### [P1] Session rows contain nested interactive controls
- **Why it matters:** The status control is nested inside the row button, producing invalid semantics and unpredictable keyboard/screen-reader behavior. Its label is also hardcoded as “Change todo state.”
- **Fix:** Render row and status as sibling buttons with deterministic focus order; localize “Change session status.”
- **Suggested command:** `$impeccable audit`

### [P2] Composer hierarchy collapses under narrow width
- **Why it matters:** Sources, cwd, status, labels, priority, due date, model and effort compete with the message and send/stop controls.
- **Fix:** Keep input, send/stop and exceptions visible. Collapse unchanged defaults into a Session setup summary and reveal deviations on demand.
- **Suggested command:** `$impeccable distill`

### [P2] Onboarding does not explain the provider decision
- **Why it matters:** Six options mix subscription, API, backend and local runtime concepts. Claude/ChatGPT are highlighted without explaining the recommendation criterion.
- **Fix:** Replace the repeated welcome with “Choose how Craft Agents runs,” group subscription/API/local paths, explain privacy/cost/runtime trade-offs and tighten claims.
- **Suggested command:** `$impeccable onboard`

### [P2] Typography contract still drifts
- **Why it matters:** 10px/11px text accounts for nearly all actionable detector findings and weakens readability, especially in dense panels. The sidecar also uses 14px while DESIGN.md declares a 15px body step.
- **Fix:** Reconcile DESIGN.md and sidecar first, then migrate compact labels to deliberate 12px/13px roles rather than bulk replacement.
- **Suggested command:** `$impeccable typeset`

## Persona Red Flags

**Alex — power user:** Welcome adds ceremony before useful setup; narrow composer forces scanning defaults; provider selection advances immediately without comparison.

**Sam — accessibility-dependent:** Nested row/status interactivity breaks predictable focus; Set up later measured about 59×15px; provider error has no alert/live semantics; 10px/11px copy remains widespread.

**Jordan — first-timer:** Hermes, ACP and Ollama are not defined; highlighted providers lack rationale; provider framing scrolls away; Get Started labels both beginning and completion actions.

## Minor Observations

- “I use other provider” should be “I use another provider.”
- “Setup later” should be “Set up later.”
- Final CTA should say “Open Craft Agents” or “Start first session.”
- Inter findings are false positives: DESIGN.md explicitly allows Inter as an opt-in preference.
- Playground, instrumentation and color-picker sample data should be excluded from product detector metrics.
- `rounded-[3px]` provider icons evade the current radius detector despite being outside the documented scale.

## Questions to Consider

- Should provider recommendation prioritize an existing subscription, privacy/locality, or runtime capability?
- Which composer controls matter when their values equal defaults?
- What visual detail identifies Craft Agents without its logo?
