# Tasks

All production changes land in `apps/electron/src/main/browser-cdp.ts` — plus the single consumer
signature in `apps/electron/src/main/browser-pane-manager.ts` that task 6.3 widens; all tests land
in the existing harness `apps/electron/src/main/__tests__/browser-cdp.test.ts`.

## 1. In-flight gate on the idle detach

- [x] 1.1 Add an in-flight command counter to `BrowserCDP`, incremented in `send()` before the
  `sendCommand` await and decremented in its `finally`, and re-arm the idle timer right after
  `ensureAttached()` so the command starts inside a full window.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "inflight" apps/electron/src/main/browser-cdp.ts`
- [x] 1.2 Extract the timer decision into a pure, exported helper
  (`decideIdleDetach({ attached, inflight })` → `'detach' | 're-arm' | 'idle'`) and drive the
  `resetIdleDetachTimer` callback from it, so the gate is testable without Electron or real timers.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "decideIdleDetach" apps/electron/src/main/browser-cdp.ts`
- [x] 1.3 Cover the gate: `decideIdleDetach` truth table, and an end-to-end assertion that an idle
  deadline elapsing during a pending `sendCommand` neither detaches nor rejects the command, and
  that a deadline after the command settles does detach.
  - files: `apps/electron/src/main/__tests__/browser-cdp.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`

## 2. The click fallback stops reporting phantom success

- [x] 2.1 In `clickAtCoordinates`, track whether the press was delivered; on a detach-shaped error
  re-attach and replay the click through the existing CDP path once, propagating if the replay
  fails; propagate directly when the press had already been delivered; keep the native
  `sendInputEvent` fallback only for the no-press case, preceded by a `mouseMove`, and let its own
  errors propagate.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "DETACHED_TARGET_ERROR_PATTERNS" apps/electron/src/main/browser-cdp.ts`
- [x] 2.2 Cover the branches: detach → successful CDP replay resolves; detach → failing replay
  rejects with no native events; failure after a delivered press rejects with no native events;
  non-detach failure before the press uses the native fallback and moves the mouse first; a
  throwing native fallback rejects.
  - files: `apps/electron/src/main/__tests__/browser-cdp.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`

## 3. Trailing geometry reads become best-effort

- [x] 3.1 Add a best-effort geometry helper (`tryReadGeometry`) and use it in `fillElement`,
  `selectOption` and `setFileInputFiles`: read geometry best-effort before the action, refresh it
  best-effort after, and fall back to the pre-action reading. Leave the pre-click geometry read in
  `clickElement` strict. (Superseded in part by task 6.3, which drops the strict fallback read the
  first pass left at the end of those three methods.)
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "tryReadGeometry" apps/electron/src/main/browser-cdp.ts`
- [x] 3.2 Cover it: a fill whose post-action `DOM.getBoxModel` fails resolves with the pre-action
  geometry; a fill on an element that can never be measured still types (and, after task 6.3,
  resolves without geometry); a click whose geometry read fails still rejects.
  - files: `apps/electron/src/main/__tests__/browser-cdp.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`

## 4. Stale-node protocol errors are translated

- [x] 4.1 Extract the stale-ref message shared with `resolveRef` (`STALE_REF_ADVICE`) and map
  errors containing `Node cannot be found` / `No node with given id` raised inside `send()` onto
  it; leave every other error untouched.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "node cannot be found" apps/electron/src/main/browser-cdp.ts`
- [x] 4.2 Cover the mapping helper's positive and negative cases, and assert the translated message
  reaches the caller through a real command path.
  - files: `apps/electron/src/main/__tests__/browser-cdp.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`

## 5. Gates and documentation

- [x] 5.1 `openspec validate harden-browser-cdp-inflight --strict --no-interactive`
- [x] 5.2 `bun run typecheck:electron`
- [x] 5.3 `cd apps/electron && bun run lint` — crashes identically with and without this change
  (`@typescript-eslint/typescript-estree` 8.64 cannot load under TypeScript 7; documented as
  `//lint:check` in `apps/electron/package.json`). No dependency change is in scope here.
- [x] 5.4 `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] 5.5 Full `bun test` compared against a stashed baseline: identical failure set (39 failures
  on this branch's baseline commit, all pre-existing).
- [x] 5.6 DOX pass: record the in-flight/geometry/error-translation contract in the root
  `AGENTS.md`.

## 6. Review corrections

- [x] 6.1 Bound the in-flight gate: give every dispatched command a deadline
  (`CDP_COMMAND_TIMEOUT_MS`) so a command the page never answers rejects, releases the gate and
  lets the idle detach run. Chosen over counting re-arms because it also unblocks the hung caller
  instead of only detaching around it.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "CDP_COMMAND_TIMEOUT_MS" apps/electron/src/main/browser-cdp.ts`
- [x] 6.2 In `clickAtCoordinates`, resend only `mouseReleased` when a detach-shaped failure happens
  after `pressDelivered` — the delivered press cannot be retracted, and a full replay double-fires
  every `mousedown` handler while still resolving as a success.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`
- [x] 6.3 Drop the strict `?? await this.getElementGeometry(ref)` fallback from `fillElement`,
  `selectOption` and `setFileInputFiles`, widen their return to
  `Promise<ElementGeometry | undefined>` and widen `BrowserPaneManager.uploadFile` to match.
  - files: `apps/electron/src/main/browser-cdp.ts`,
    `apps/electron/src/main/browser-pane-manager.ts`
  - verify: `bun run typecheck:electron`
- [x] 6.4 Give `clickAtCDP` the humanized path's signature: `buttons: 1` on the press, `buttons: 0`
  on the release, and the same 20–60ms gap between them.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`
- [x] 6.5 Route the `Emulation.setEmulatedMedia` reapplication in `ensureAttached` through the
  gated dispatch path, and clear the idle timer inside the external `debugger.on('detach')`
  listener the way the internal `detach()` already does.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `grep -q "sendGated" apps/electron/src/main/browser-cdp.ts`
- [x] 6.6 Re-arm the idle timer in the dispatch `finally` only while still attached, so an explicit
  `detach()` is not followed by another 5s window holding the `webContents` alive.
  - files: `apps/electron/src/main/browser-cdp.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`
- [x] 6.7 Cover the corrections: a command that never answers rejects on the deadline and then lets
  the debugger detach; a detach-shaped failure on `mouseReleased` leaves exactly one press on the
  page; fill, select and file assignment on a never-measurable element resolve without geometry;
  the CDP replay carries `buttons: 1`/`buttons: 0`.
  - files: `apps/electron/src/main/__tests__/browser-cdp.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-cdp.test.ts`
