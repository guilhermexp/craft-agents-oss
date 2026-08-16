/**
 * Side-effect module that MUST be the first import in `main.tsx`.
 *
 * `react-dom/client` calls `injectInternals` during its own module evaluation,
 * and React only enables `ProfileMode` — the flag that populates
 * `fiber.actualDuration` — for roots created while a DevTools hook is present.
 * Both happen before any statement in `main.tsx` runs, so installing from a
 * function call there would silently produce a monitor with zero durations.
 *
 * Development only. A production renderer records no timings and minifies
 * component names, so the hook would add cost for a table of `t7`/`u3` rows.
 * The frame, RPC and process collectors work in both builds; the interaction
 * collector runs too, but its settle latency is derived from commit activity,
 * so it is only meaningful while this hook is installed (see `interactions.ts`).
 */

import { installReactCommitHook } from './react-commits'

if (import.meta.env.DEV) installReactCommitHook()
