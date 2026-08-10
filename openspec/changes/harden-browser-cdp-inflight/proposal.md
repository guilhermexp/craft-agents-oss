# Harden Browser CDP In-Flight Handling

## Why

A real runtime log (session `260727-still-brook`, 2026-08-09) shows the agent driving the browser
pane on a login screen and losing work in two distinct ways.

**The idle detach races the command it is supposed to protect.** Twice in the same log, one
millisecond apart:

```
20:20:18.971 (main) [browser-cdp] idle detach — detaching debugger after inactivity
20:20:18.972 (main) [browser-cdp] CDP clickAt failed, falling back to native sendInputEvent: target closed while handling command
```

`BrowserCDP.send()` re-arms the idle timer in its `finally`, and the comment there claims this
avoids detaching mid-flight. It does not: the `finally` protects the *next* command, not the
current one. The current command runs with whatever is left of the previous 5s window, so any
command that starts late in that window is detached out from under itself. There is no in-flight
counter anywhere in the class, so the timer callback cannot know a command is running.

**A lost click is reported as a successful click.** `clickAtCoordinates` catches the resulting
`target closed while handling command`, logs it, and replays the click through
`webContents.sendInputEvent` without re-attaching, without retrying CDP, and without rethrowing.
`sendInputEvent` only reaches the main frame and silently no-ops on cross-origin frames (the code
says so itself), so `clickElement` and the pane manager record `status: 'succeeded'` for a click
that never landed. When the failure happens on `mouseReleased`, the fallback also emits a second
down/up pair on top of an already-delivered press.

**A successful action dies on the geometry read that follows it.** `fillElement` ends with
`return await this.getElementGeometry(ref)`. On a login form the fill submits, the page navigates
to `/dashboard`, the node dies, and the fill — which worked — is reported as a failure. That
geometry is only bookkeeping for the screenshot annotation overlay (`lastAction.geometry`, already
optional downstream); it is not the result of the action.

**The failure the agent sees is raw Blink.** The same log ends with `Node cannot be found in the
current page.` reaching the model. `resolveRef` already produces a friendly, actionable stale-ref
message, but the command had already passed `resolveRef` and was in flight when navigation
committed, so the raw CDP string escaped instead.

## What Changes

- Track in-flight CDP commands on `BrowserCDP` and gate the idle detach on that count: the timer
  re-arms instead of detaching while a command is running, and a command re-arms the timer as soon
  as it is attached so it starts inside a full window instead of inheriting the tail of the
  previous one.
- Make the click fallback stop reporting phantom success: a detach-shaped failure re-attaches and
  replays the click through CDP once; a failure after the press was already delivered propagates
  instead of double-firing a native down/up pair; the native fallback keeps its narrow slot (CDP
  unusable, nothing pressed yet) and now warms up with a `mouseMove` first.
- Make post-action geometry reads best-effort in `fillElement`, `selectOption` and
  `setFileInputFiles`: each reads geometry before acting, refreshes it after, and returns the
  pre-action reading if the node died in between. An element that has no box model at either end
  — `<input type="file" style="display:none">`, a `<select hidden>` behind a styled dropdown —
  resolves with no geometry at all, so the three methods return `ElementGeometry | undefined`.
  `clickElement` keeps its strict read; there the geometry is the click target, a real
  precondition.
- Translate raw Blink stale-node errors (`Node cannot be found in the current page.`, `No node with
  given id found`) surfacing from `send()` into the same actionable stale-ref message `resolveRef`
  already produces.

## Non-Goals

- Do not change `CDP_IDLE_DETACH_MS`. The 5s window is not the bug; the missing in-flight gate is.
  A permanently attached debugger is a passive bot-detection tell, so idle detach stays.
- Do not refactor the browser pane, `browser-pane-manager.ts`, or the `WebContentsView`
  architecture.
- Do not touch `browser-visual-capture.ts`. Its `Promise.allSettled` batch of `getBoxModel` calls
  swallows per-ref failures; that is a separate concern.
- Do not change the debugger session model (single `webContents.debugger` consumer per pane).
- Do not address the other findings from the same log (tool blocking ending the turn, favicon CSP,
  tool-matching `store miss`); those are separate changes.

## Corrections From Review

An independent review of the first implementation found three P1s (two of them regressions against
`main`) and three lower-severity gaps. All of them land in the same change.

- **A hung command pinned the debugger attached forever (P1, regression).** With the in-flight gate
  in place, `decideIdleDetach` re-armed without a ceiling and `send()` had no timeout, so a command
  that never answers — `Runtime.evaluate` over `navigator.clipboard.readText()`, or any input
  dispatch to a renderer blocked on `alert()`/`confirm()` — kept `inflight` at 1 indefinitely. On
  `main` the 5s idle detach cut that hang; the gate removed the scythe and violated this change's
  own Non-Goal. Fixed by bounding the wait inside `send()` (`CDP_COMMAND_TIMEOUT_MS`, 30s) rather
  than by counting re-arms: the deadline releases the gate *and* the hung caller in one move, so no
  command is left pending forever and the failure reaches the agent as an error instead of silence.
  Counting re-arms would detach while still leaving the caller hanging.
- **The click replay delivered two `mousedown`s (P1).** The detach-shaped branch replayed the whole
  click without consulting `pressDelivered`. A failure on `mouseReleased` happens *after* the press
  was delivered and confirmed, and detaching does not retract an event the renderer already saw, so
  the page received `mousedown, mousemove, mousedown, mouseup, click` and the call resolved as a
  success. Now the replay resends only `mouseReleased` when the press was already delivered, and
  replays the whole click only when it was not.
- **The strict trailing read cancelled the best-effort contract (P1).** `return geometry ?? await
  this.getElementGeometry(ref)` re-issued the strict read when both best-effort reads failed, so an
  element that never has a box model made a *completed* fill/select/file assignment reject — the
  same action-vs-status divergence this change exists to remove, inverted. The fallback read is
  gone; the three methods return `ElementGeometry | undefined`.
- **`clickAtCDP` was promoted to the replay path without being updated (P2).** It omitted `buttons`
  on the press (Blink then reports `event.buttons === 0` on a mousedown, a state human input cannot
  produce) and had no press-to-release gap. It now carries `buttons: 1`/`buttons: 0` and the same
  20–60ms gap as the humanized path.
- **The reattach's own command bypassed the gate (P2).** `ensureAttached` reapplied
  `Emulation.setEmulatedMedia` through `webContents.debugger.sendCommand` directly, invisible to
  `decideIdleDetach`. It now goes through the gated dispatch path, and the external-detach listener
  clears the idle timer the way the internal `detach()` already did.
- **`send`'s `finally` re-armed the timer after an explicit detach (P3).** It now re-arms only while
  attached, so `destroyInstance` no longer keeps `BrowserCDP` and its `webContents` alive for
  another window.