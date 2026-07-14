# Embedded Browser + CDP Replication Guide

This is a self-contained, app-agnostic guide for building an **agent-controlled,
Electron-owned in-app browser** driven by the Chrome DevTools Protocol (CDP). It
assumes only an Electron app and a backend that runs an AI agent. It does not
reference any specific repository, product, or agent implementation — replicate
it from this document alone.

The design is not "open the user's Chrome". It is an Electron-owned Chromium
host:

1. A chromeless `BrowserWindow` is created for each browser instance.
2. Three `BrowserView`s are added to that window:
   - `pageView`: the real web page.
   - `toolbarView`: the app-controlled toolbar UI.
   - `nativeOverlayView`: an app-controlled overlay for agent ownership/menu
     capture.
3. Automation attaches to `pageView.webContents.debugger` and sends Chrome
   DevTools Protocol commands.
4. Agents do not receive `BrowserWindow`, `BrowserView`, or CDP directly. They
   receive one CLI-like tool, `browser_tool`, backed by session-scoped callback
   functions.

Throughout this guide, component names (`BrowserPaneManager`, `BrowserCDP`,
`IBrowserPaneManager`, `BrowserPaneFns`, etc.) are **suggested module names**,
not paths. Use whatever layout your app prefers; keep the responsibilities and
boundaries intact.

## Component Map

| Concern | Suggested module |
| --- | --- |
| Browser window/view lifecycle | `BrowserPaneManager` |
| CDP automation | `BrowserCDP` |
| Screenshot pipeline | `BrowserVisualCapture` |
| Profile partition mapping | `browser-profile-resolver` |
| Toolbar preload API | `browser-toolbar` preload (bundled to `.cjs`) |
| Main-process browser RPC handlers | browser RPC handler module |
| Public browser pane interface | `IBrowserPaneManager` |
| Agent-facing browser callback type | `BrowserPaneFns` |
| `browser_tool` parser/runtime | `browser-tool-runtime` |
| Session callback registry | session-scoped callback registry |
| Session/runtime wiring | `SessionManager` (your agent session layer) |
| Out-of-process backend bridge | session-tools MCP server |
| Remote browser wire protocol | browser-capability transport |
| Remote browser proxy | `RemoteBrowserPaneManager` |
| Renderer channel names | a shared channel-name constant module |

## Agent Backends

This guide is backend-neutral. Two backend shapes are supported and are referred
to abstractly:

- **In-process SDK backend**: the agent runs in the same process as the app and
  consumes native tool adapters directly.
- **Out-of-process backend (ACP/MCP)**: the agent runs as a separate process
  (e.g., a language-server-style protocol) and consumes the same tools through a
  local MCP server.

Wherever a difference matters, it is called out explicitly.

## Architecture

```text
Agent backend (in-process SDK or out-of-process ACP/MCP)
  |
  | calls browser_tool({ command: "..." })
  v
browser-tool-runtime
  |
  | parses CLI command and calls BrowserPaneFns
  v
SessionManager browserPaneFns
  |
  | resolves session-owned browser instance
  v
IBrowserPaneManager
  |
  | local Electron path: BrowserPaneManager
  | remote path: RemoteBrowserPaneManager -> client:browser:invoke -> __browser:invoke
  v
BrowserPaneManager
  |
  | owns BrowserWindow + BrowserViews
  v
BrowserCDP(pageView.webContents)
  |
  | uses webContents.debugger / CDP
  v
Chromium page
```

The important boundary is `IBrowserPaneManager`. Everything above it is
agent/session/runtime logic. Everything below it is the local desktop browser
host. (`client:browser:invoke` / `__browser:invoke` are example IPC channel
names; pick your own.)

## Browser Host Model

`BrowserPaneManager.createInstance()` is the core constructor.

It creates:

- `BrowserWindow`
  - `frame: false`
  - `show: false` until toolbar is ready
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
- `toolbarView`
  - custom preload (bundled CJS, e.g. `browser-toolbar-preload.cjs`)
  - same Electron partition/session as the page
  - `sandbox: false` because the preload exposes app IPC
- `pageView`
  - the actual remote web content
  - `sandbox: true`
- `nativeOverlayView`
  - transparent app overlay
  - used for agent-control lock and toolbar menu tap-catcher

The page view gets the automation object:

```ts
const cdp = new BrowserCDP(pageView.webContents)
```

The views are stacked in this order:

```ts
window.addBrowserView(pageView)
window.addBrowserView(nativeOverlayView)
window.addBrowserView(toolbarView)
window.setTopBrowserView(toolbarView)
```

Layout invariant:

- toolbar is always at `y = 0`, height `TOOLBAR_HEIGHT` (e.g. `48`).
- page starts at `y = TOOLBAR_HEIGHT`.
- overlay starts at `y = TOOLBAR_HEIGHT` and covers the page area only.
- toolbar stays topmost even when overlay is active.

Replicate this shape directly. Do not embed the browser page in the React app
DOM. It must be a native Electron `BrowserView`/`WebContents` so CDP,
partitions, downloads, permissions, and media capture behave like Chromium.

## Agent Control Overlay And User Lock

When an agent is actively using the browser, the app shows a native overlay on
top of the page area and blocks user interaction until control is released. This
is implemented in `BrowserPaneManager`, not inside the remote page DOM.

Activation path:

1. `SessionManager` receives a `tool_start` event.
2. `shouldActivateBrowserOverlay()` confirms the tool is the browser tool
   (canonical name `browser_tool`, or a namespaced alias such as
   `mcp__session__browser_tool`).
3. Help/lifecycle commands are ignored: `--help`, `-h`, `help`, `open`,
   `release`, `close`, and `hide`.
4. For actionable commands, the session manager ensures a browser instance
   exists with `getOrCreateForSession(sessionId)`.
5. It calls `BrowserPaneManager.setAgentControl(sessionId, { displayName,
   intent })`.

The overlay page is a `data:` URL loaded into `nativeOverlayView`. It contains
three elements:

- `#overlay`: fixed full-view container with a transparent border by default.
- `#shield`: fixed full-view interaction blocker.
- `#chip`: fixed top-right status chip with the active tool name and intent.

When `agentControl.active` is true:

- the native overlay view is bounded to the page area:
  `{ x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT }`;
- the overlay border and inset glow use the current app accent color (this is
  the colored border users see around the page while the agent is in control);
- the chip is shown with `displayName - intent`, or a fallback label;
- `#shield.style.pointerEvents = "auto"`;
- `#shield.style.cursor = "not-allowed"`;
- `#shield.style.background = "rgba(2, 6, 23, 0.03)"`.

That shield is what prevents the user from clicking links, buttons, inputs, or
the page body while the agent owns the browser. The toolbar remains topmost, but
keyboard input is also blocked while the lock is active:

- `pageView.webContents.on("before-input-event", ...)` calls
  `event.preventDefault()` when `instance.lockState.active` is true;
- `toolbarView.webContents.on("before-input-event", ...)` does the same;
- DevTools shortcuts are handled before this block so the app can still detach
  CDP and open DevTools deliberately.

`applyAgentControlLock()` also sets the native window to non-resizable while
agent control is active, then restores the previous resizable state on release.

Release path:

- `browser_tool release` releases the target window overlay;
- `browser_tool release all` clears all active overlays for the session;
- session turn completion calls `clearVisualsForSession(sessionId)`;
- when the session is truly idle, `unbindAllForSession(sessionId)` releases
  browser ownership as well;
- forced stop, plan handoff, auth handoff, window teardown, and session teardown
  also clear the overlay through `clearAgentControl`,
  `clearAgentControlForInstance`, or `clearVisualsForSession`.

For a 1:1 port, treat "pause/stop by user" as a release path. The user-visible
rule should be: while the agent is actively running an actionable browser tool,
the accent overlay is visible and page navigation/input is blocked; once the
turn is paused, stopped, released, or completed, the overlay disappears and the
window returns to normal interaction.

### Cursor Bubble / Thinking Output

The base design does not implement a bubble that follows the cursor with live
agent output or thinking text. The implemented status surfaces are:

- the top-right `#chip` inside `nativeOverlayView`;
- a browser status indicator in the app's main input toolbar;
- the browser tab badge accent state.

If your app needs a cursor-following bubble as part of its UX, implement it as an
additional element inside `nativeOverlayView`, not inside the remote page:

1. Add a `#cursor-bubble` element to the overlay HTML.
2. Track pointer position from overlay/page mouse events and position the
   bubble with a small viewport-clamped offset.
3. Feed it sanitized, compact text from the session event stream
   (`tool_start`, thinking/status deltas, or selected assistant deltas).
4. Keep the bubble `pointer-events: none` so `#shield` remains the element that
   blocks user interaction.
5. Hide and clear it on `clearAgentControl`, `clearVisualsForSession`,
   screenshots, and window teardown.

Do not inject this bubble into the page DOM. It must be native overlay UI so it
cannot be affected by site CSS, CSP, navigation, or cross-origin frames.

## Profiles, Cookies, And Storage

Browser identity is controlled by Electron session partitions.

Suggested mapping:

```ts
default profile -> persist:browser
custom profile  -> persist:browser:<profileId>
```

Why this matters:

- cookies and local storage survive app restarts;
- separate profiles isolate accounts/client contexts;
- a browser instance cannot switch to a different cookie jar without recreating
  or moving to a view using the new partition;
- a session-owned browser can only reuse a manual/unbound window if profile and
  (optional) workspace scope are compatible.

When replicating, keep a tiny profile→partition resolver and never use Electron's
default session for the browser.

## User Agent

The page `webContents.userAgent` is sanitized before navigation:

- remove `Electron/<version>`;
- remove the app token derived from `app.getName()`;
- normalize duplicate whitespace.

This makes the page UA look like normal Chrome instead of Electron. Keep this if
you need sites to treat the pane like a normal browser.

## CDP Automation

`BrowserCDP` wraps Electron's `webContents.debugger` API.

Attach rule:

```ts
webContents.debugger.attach("1.3")
webContents.debugger.sendCommand(method, params)
```

The debugger is attached lazily on first use and detached after an idle timeout
(e.g. `CDP_IDLE_DETACH_MS = 5000`). This avoids keeping a permanent debugger
attached.

If DevTools is already open, automation fails with an actionable error because
Electron DevTools and `webContents.debugger` are mutually exclusive. Before
opening DevTools, detach the CDP helper.

### Accessibility Snapshot

The agent does not click CSS selectors by default. It first requests an
accessibility snapshot:

```ts
Accessibility.getFullAXTree
```

`BrowserCDP.getAccessibilitySnapshot()`:

- filters the AX tree to useful interactive/content nodes;
- assigns stable-looking refs such as `@e1`, `@e2`;
- stores `ref -> backendDOMNodeId` in `refMap`;
- stores semantic details in `refDetails`;
- keeps a stable `backendDOMNodeId -> ref` map so re-snapshotting the same
  document reuses the same ref for the same node;
- returns `{ url, title, nodes }`.

Only refs from the most recent snapshot of the current document are valid:

- each snapshot rebuilds `refMap`, so refs from an older snapshot that no
  longer resolve are rejected;
- `did-navigate` and `did-navigate-in-page` (SPA route changes) clear all
  three maps, so any pre-navigation ref is rejected until a new snapshot runs;
- the ref counter is monotonic (never reset), so a pre-navigation ref number
  is never reused by a post-navigation snapshot — a stale ref can never
  silently resolve to a different element.

Actions (`click`/`fill`/`select`/geometry/upload) resolve refs through a single
helper that fails with a "stale ref — run browser_snapshot first" error.

### Element Geometry

For ref-based interactions:

```ts
DOM.getBoxModel({ backendNodeId })
```

The box model content quad is converted into:

- bounding box;
- center click point;
- semantic metadata for screenshots.

There is also selector geometry support for region screenshots:

```ts
Runtime.evaluate(document.querySelector(...).getBoundingClientRect())
```

### Clicks

Ref click flow:

1. `DOM.resolveNode`
2. `Runtime.callFunctionOn(... scrollIntoViewIfNeeded ...)`
3. `DOM.getBoxModel`
4. `Input.dispatchMouseEvent` through CDP

Important: coordinate clicks route through CDP first, not
`webContents.sendInputEvent`. CDP hit-tests in the browser process and works
better across cross-origin frames, shadow DOM, and challenge widgets. Native
`sendInputEvent` remains only as a fallback.

### Drag

Drag primarily uses native `webContents.sendInputEvent` with a generated
trajectory and falls back to CDP `Input.dispatchMouseEvent` if native input
fails.

### Fill / Type / Select

Fill:

1. `DOM.focus`
2. clear `value` in page context
3. dispatch `input`
4. type characters with `Input.dispatchKeyEvent`
5. dispatch `change`

Type:

- dispatches `keyDown`/`keyUp` with text for each character.

Select:

- handles native `<select>` by setting `value` and dispatching `input/change`;
- handles ARIA/listbox-style controls by opening the control, finding visible
  `[role="option"]`, `option`, or `[data-value]`, clicking the match, and
  verifying that form state changed.

### Upload

File upload uses:

```ts
DOM.setFileInputFiles({ files, backendNodeId })
```

Validate local paths before passing them to CDP. Remote browser upload is
intentionally blocked in the capability dispatcher (see Remote Host Path).

### Clipboard

Clipboard uses page-context `navigator.clipboard` through `Runtime.evaluate`
with `userGesture: true`.

## BrowserPaneManager Operations

`BrowserPaneManager` exposes all browser behavior through `IBrowserPaneManager`.
Core categories:

- lifecycle: `createForSession`, `getOrCreateForSession`,
  `focusBoundForSession`, `destroyForSession`, `unbindAllForSession`;
- agent control: `setAgentControl`, `clearAgentControl`,
  `clearAgentControlForInstance`, `clearVisualsForSession`;
- navigation: `navigate`, `goBack`, `goForward`, `reload`, `stop`;
- interaction: `snapshot`, `click`, `clickAt`, `drag`, `fill`, `type`,
  `select`, `sendKey`, `scroll`, `uploadFile`, `evaluate`;
- capture: `screenshot`, `screenshotRegion`;
- observability: `getConsoleLogs`, `getNetworkLogs`, `waitFor`,
  `getDownloads`, `detectSecurityChallenge`;
- UI state: `listInstances`, `focus`, `hide`, profile operations, state events.

Two operations listed above (`reload`, `stop`) are typically concrete
`BrowserPaneManager` methods exposed through toolbar IPC rather than members of
`IBrowserPaneManager`. If the session/runtime layer depends only on the
interface (recommended), route reload/stop through the toolbar/renderer path,
not through the session abstraction.

Sync vs async: ship sync local methods plus async twins for the remote bridge —
`getOrCreateForSessionAsync`, `createForSessionAsync`, `getInstanceAsync`,
`listInstancesAsync`, `focusBoundForSessionAsync`. The sync forms cannot survive
a remote (WebSocket) round-trip, so any remote-aware caller MUST use the async
forms.

Other interface members needed for a full port: `setSessionPathResolver`
(downloads dir), `bindSession`, `windowResize`, `setClipboard`/`getClipboard`,
and `getInstance`/`getInstanceAsync`.

Navigation normalization:

- full URL with scheme loads as-is;
- `about:` loads as-is;
- host-looking input gets `https://`;
- other input becomes a search-engine query (e.g. a default search provider).

Navigation has a timeout (e.g. 30s) and treats `ERR_ABORTED` as potentially
benign because redirects and replacement navigations often trigger it.

## Navigation Policy, Popups, And Deep Links

URL normalization (above) is only half of navigation. Each instance should also
accept an optional navigation policy (a `createInstance` option stored on the
instance):

```ts
interface BrowserNavigationPolicy {
  willNavigate?(url: string): BrowserNavigationDecision
  windowOpen?(url: string): BrowserNavigationDecision
}
type BrowserNavigationDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'external'; reason?: string }
```

Wired on the page `webContents`:

- `on('will-navigate')` consults `willNavigate`. `deny` calls
  `event.preventDefault()`; `external` prevents and `shell.openExternal`s.
- `setWindowOpenHandler` consults `windowOpen`, then enforces defaults: deny
  invalid URLs and any non-`http(s)` protocol, otherwise allow a child
  `BrowserWindow` (e.g. 520x720, `parent: instance.window`, same
  partition/session as the page).
- `on('did-create-window')` registers each child popup. Popups are tracked per
  parent instance (parent→popups and webContentsId→parent maps), unregistered on
  `closed`, and destroyed on instance teardown.

Deep links: if your app registers a custom URL scheme (e.g. `myapp://`),
intercept it in both `will-navigate` and the window-open handler and route it to
your deep-link handler instead of loading it in the pane.

For a port: keep the policy hook (it is how the host blocks off-scope navigation
or hands links to the OS browser) and the popup lifecycle (otherwise
`window.open` / `target=_blank` either silently fails or leaks orphan windows).

## Agent Session Ownership

Each browser instance tracks:

- `boundSessionId`
- `ownerType`: `session` or `manual`
- `ownerSessionId`
- optional workspace/scope id
- visibility, URL/title, loading state, profile, last action, logs, downloads.

For local sessions:

- `createForSession(sessionId)` reuses an existing bound instance if available.
- Otherwise it can adopt an unbound manual window only if scope/profile rules
  allow it.
- `getOrCreateForSession(sessionId)` creates in background.
- `focusBoundForSession(sessionId)` creates and shows/focuses.

For remote sessions:

- the owner key is rewritten to a remote namespace (e.g.
  `remote:<scope>:<sessionId>`);
- manual/unbound reuse is disabled;
- every operation with an instance id verifies ownership first;
- `listInstances` returns only instances owned by that remote owner;
- `evaluate` can be blocked by settings;
- upload is blocked.

This ownership model is mandatory if more than one agent/session/scope can use
the same desktop browser host.

## Agent-Facing Tool Layer

Agents never call `BrowserPaneManager` directly. They call one tool:

```ts
browser_tool({ command: "navigate https://example.com" })
```

The command schema is:

```ts
z.object({
  command: z.union([z.string(), z.array(z.string())])
})
```

String mode supports CLI-like commands and semicolon batching:

```text
fill @e1 user@example.com; fill @e2 password; click @e3
```

Batching stops after navigation-like commands (`navigate`, `click`, `back`,
`forward`) because page state may have changed and a new snapshot is required.

Array mode bypasses tokenization and preserves raw text:

```json
["evaluate", "var x = 1; var y = 2; x + y"]
```

`BrowserPaneFns` is the agent-facing callback interface. The session manager
builds it by binding each callback to the session's browser instance:

```ts
navigate(url) -> resolve session instance -> bpm.navigate(instanceId, url)
snapshot()    -> resolve session instance -> bpm.getAccessibilitySnapshot(instanceId)
click(ref)    -> resolve session instance -> bpm.clickElement(instanceId, ref)
```

The callback registry is a `Map<sessionId, callbacks>`. Browser callbacks are
merged into existing session callbacks so other backend-provided callbacks are
not overwritten.

## Agent-Facing Instruction Surface (The Real "Skill")

Porting the host and the runtime is not enough for an agent to actually drive
the browser — it must also be *taught* the protocol (snapshot-first, `@eN` refs,
batching, release-when-done). Where that instruction lives depends on the
backend:

- In-process SDK backend: there is no separate markdown skill. The teaching
  surface is the tool itself and travels with the runtime:
  - the tool **description string** registered in the tool schema. This is the
    agent's primary instruction: it documents the command grammar, string vs
    array mode, semicolon batching, and every command. Port it verbatim (or
    adapt wording), not just the executor.
  - the `--help` output, a full command reference the agent can request at
    runtime.
  - a release hint appended after actionable commands to remind the agent to
    `release`/`close` when finished.

- Out-of-process backend (ACP/MCP): in addition to the tool description, such
  backends usually read instructions from a skill tree on disk. If yours does,
  author a small seed skill (a markdown file) whose only browser content is:
  prefer the in-app browser tool, and a validation target
  (`open/navigate -> evaluate document.title -> close`). Add a bootstrap step
  that copies the seed skill into the backend's skill directory on first run,
  preserving user edits.

Port rule:

- Always carry the tool description + help text; that string *is* the implicit
  skill for in-process agents.
- Only author a markdown seed skill (plus its bootstrap copier) if the target
  app embeds an out-of-process backend that reads skills from a skill tree. For
  in-process-only apps, the tool description is sufficient.

## Out-Of-Process Backend Bridge (ACP/MCP)

An out-of-process agent backend cannot consume the in-process SDK tool adapter,
so expose the same session tools through a local MCP server.

The bridge:

- starts a local Streamable HTTP MCP server on `127.0.0.1`;
- lists canonical session tool definitions;
- includes `browser_tool` only when the built-in browser setting is enabled;
- resolves `browserPaneFns` from the same session callback registry;
- calls `executeBrowserToolCommand()`.

At the MCP boundary the tool name is typically namespaced (e.g.
`mcp__session__browser_tool`), but the internal tool remains `browser_tool`.
Keep the namespacing convention consistent so overlay-activation detection and
permission checks recognize both forms.

## Renderer And Toolbar UI

There are two UI surfaces:

1. Main app UI: uses RPC channels like `browser-pane:create`,
   `browser-pane:list`, `browser-pane:focus`, and receives state events.
2. Browser toolbar UI: loaded inside `toolbarView` and talks to main through
   `browser-toolbar:*` IPC channels exposed by the toolbar preload.

Toolbar preload exposes:

- navigate/back/forward/reload/stop;
- hide/destroy;
- menu geometry updates;
- profile management and profile switching;
- state updates from main;
- a theme-color channel feeding the tab badge accent.

The toolbar is not the browser page. It is separate app UI in a separate
`BrowserView`, which is why it can stay topmost and isolated.

## Build, Preload, And Static Assets

A toolbar preload must exist as a bundled CommonJS file; it cannot be loaded as
raw TypeScript. Typical build wiring:

- Bundle the toolbar preload with esbuild to a `.cjs` file, e.g.
  `--bundle --platform=node --format=cjs --external:electron`. The manager loads
  it via `join(__dirname, 'browser-toolbar-preload.cjs')`.
- Register the toolbar and first-load HTML as renderer build inputs (e.g. Vite
  rollup inputs `browser-toolbar.html` and `browser-empty-state.html`).
- Bundle the main bootstrap preload and any network interceptor the same way;
  copy that pattern rather than importing TS preloads directly.

## Empty State Page

Ship an agent-guidance page shown on first load before navigation (a real
renderer page, launchable through a dedicated channel). Port it (or substitute
your own first-load page) so a freshly created pane is not a blank
`about:blank`.

## Toolbar Preload Surface Is Not Generic

The toolbar preload may carry app-specific extras beyond navigation/profile/
state/theme — for example tab-audio or meeting recording lifecycle APIs and the
`getDisplayMedia` flow. For a generic port, keep nav/profile/state/theme and
strip any recording/meeting lifecycle unless the target app needs it.

## Screenshots

Screenshot capture is isolated in `BrowserVisualCapture`.

Modes:

- raw: capture current page;
- agent/annotated: build element geometries, render temporary in-page overlay,
  capture, then clear overlay.

Important behaviors:

- native agent overlay is hidden during capture so it does not pollute output;
- annotated mode caps labels at a fixed number of refs (e.g. 100);
- region screenshots accept one of: coordinates, AX ref, or CSS selector;
- region boxes are padded and clipped to the viewport;
- capture has retry/recovery logic for hidden or transiently blank windows;
- image output is a `Buffer` locally, converted to base64 or `Uint8Array` at
  wire boundaries.

## Console, Network, Waits, Downloads

`BrowserPaneManager` records:

- console messages from the page;
- network completion/error entries through `session.webRequest`;
- inflight request count and last network activity timestamp;
- downloads via `session.on("will-download")`.

`waitFor` supports:

- `selector`: `document.querySelector(...)`;
- `text`: `document.body.innerText.includes(...)`;
- `url`: current URL contains value;
- `network-idle`: inflight count is zero and no network activity happened for
  `idleMs`.

Downloads are auto-saved to a deterministic per-session/per-browser downloads
directory. This avoids native file dialogs during agent runs and requires a
session-path resolver to be injected (see External Dependencies To Provide).

## Permissions And Media

Permission policy is set per Electron session partition.

Allowed permissions typically include:

- fullscreen;
- pointer lock;
- window management;
- notifications;
- geolocation;
- media;
- speaker selection;
- display capture;
- screen wake lock;
- clipboard read/write;
- idle detection.

Routine-denied permissions such as background sync are logged once per
origin/permission to avoid log spam.

Display capture is special: when the toolbar requests display media, the main
process grants the active `pageView.webContents.mainFrame` as the capture
target. This is used by tab-audio / recording flows if your app has them.

## Remote Host Path

When the agent runtime is not co-located with Electron:

1. `SessionManager` creates a `RemoteBrowserPaneManager`.
2. The remote manager packages an `IBrowserPaneManager` call into a capability
   request.
3. The RPC server sends an invoke message (e.g. `client:browser:invoke`) to the
   desktop client.
4. The desktop preload receives the request and calls
   `ipcRenderer.invoke("__browser:invoke", req)`.
5. `BrowserPaneManager.registerCapabilityIpc()` dispatches to the real local
   browser instance.

The wire shape is:

```ts
{
  v: 1,
  method: BrowserCapabilityMethod,
  args: unknown[],
  sessionId: string,
  scopeId: string
}
```

Keep this if your app will support remote/server agents that need to drive the
user's local browser. (`scopeId` is whatever tenant/workspace scope your app
uses; omit if you have none.)

## Startup Wiring

At Electron app startup:

```ts
const browserPaneManager = new BrowserPaneManager()
browserPaneManager.setWindowManager(windowManager)
browserPaneManager.registerToolbarIpc()
browserPaneManager.registerCapabilityIpc()

const sessionManager = new SessionManager()
sessionManager.setBrowserPaneManager(browserPaneManager)
```

When registering main app handlers, pass `browserPaneManager` into handler
deps so renderer channels can create/list/focus/navigate browser instances.

When a session starts, `SessionManager` must merge `browserPaneFns` into
session-scoped callbacks. The function implementation should always resolve the
current session-bound browser instance before delegating to
`IBrowserPaneManager`.

## External Dependencies To Provide

`BrowserPaneManager` is not self-contained. To port it, supply:

- `setWindowManager(windowManager)`: owns/positions the chromeless windows.
- `setSessionPathResolver(fn)`: maps `sessionId -> session dir`; downloads land
  under `<sessionPath>/downloads`. Without it, auto-download routing is inert.
- Accent color source: the overlay border/glow uses the current app accent; pin
  it to your theme provider.
- Settings gates: built-in-browser-enabled (controls whether `browser_tool` is
  listed at the MCP bridge) and the `evaluate` gate (sensitive). Provide both.
- Logger: a logger is used throughout; swap for the target app's logger.

## 1:1 Replication Checklist

Copy these pieces in this order:

1. `BrowserCDP`
   - lazy attach/detach;
   - AX snapshot and `@eN` refs;
   - geometry resolution;
   - click/fill/type/select/upload/clipboard helpers.
2. `BrowserPaneManager`
   - instance map;
   - `BrowserWindow` + three `BrowserView`s;
   - profile partition resolver;
   - lifecycle, navigation, state, ownership, and cleanup;
   - native agent-control overlay with accent border, shield, chip, and lock;
   - session permissions and observers;
   - toolbar IPC;
   - capability IPC if remote agents exist.
3. Optional cursor-following status bubble
   - add only if this UX is required in the target app;
   - implement inside `nativeOverlayView`;
   - keep `pointer-events: none` and let `#shield` keep blocking input;
   - feed compact, sanitized session/thinking/tool status text;
   - clear it on release, pause, stop, screenshots, and teardown.
4. `BrowserVisualCapture`
   - raw and annotated screenshots;
   - region screenshots;
   - buffer/wire conversions.
5. `IBrowserPaneManager`
   - make the session manager depend on this interface, not Electron classes.
6. `BrowserPaneFns`
   - callbacks exposed to agent tools.
7. `browser_tool` runtime
   - CLI parser;
   - array mode;
   - semicolon batching;
   - navigation-stop behavior;
   - output formatting and release hint;
   - the tool description + `--help` text (the agent's instruction surface).
8. Session callback registry
   - keyed by session id;
   - merge callbacks instead of replacing.
9. Session manager wiring
   - resolve local or remote `IBrowserPaneManager`;
   - register `browserPaneFns`;
   - activate overlay on actionable browser tool starts;
   - release overlay on pause, stop, completion, and explicit release;
   - enforce ownership and lifecycle target validation.
10. Toolbar UI/preload
   - keep toolbar out of the page DOM;
   - expose only minimal IPC.
11. Renderer channels/events
    - create/list/focus/navigate/screenshot/evaluate/scroll;
    - state changed/removed/interacted/profile events.
12. Navigation policy, popups, and deep links
    - per-instance `willNavigate`/`windowOpen` (allow/deny/external);
    - http(s)-only child-window handler + popup tracking/teardown;
    - custom-scheme interception routed away from the pane.
13. Build and static assets
    - esbuild the toolbar preload to `.cjs`;
    - register toolbar + empty-state HTML as renderer inputs.
14. External dependencies
    - window manager, session-path resolver, accent source, settings gates,
      logger.
15. Out-of-process backend support (only if applicable)
    - MCP bridge re-exposing the session tools;
    - a seed skill + bootstrap copier for the browser instruction.

## Invariants To Preserve

- The remote web page lives in `pageView`, not in your React DOM.
- All browser instances use explicit persistent partitions.
- The default profile partition remains stable across upgrades.
- Agents interact through `browser_tool`; they do not receive CDP handles.
- Refs are generated from accessibility snapshots and are invalid after page
  changes.
- Any click/fill/select by ref must require a prior snapshot.
- Session ownership is checked before every instance-id operation.
- Remote sessions use an owner namespace and cannot adopt manual windows.
- `evaluate` is considered sensitive and should be gateable.
- Remote upload is blocked unless you design a separate file handoff.
- CDP debugger detaches when idle and before DevTools opens.
- Toolbar and overlay are separate `BrowserView`s, not injected into the page.
- Active agent control must show the accent border/status chip and block page
  interaction until release, pause, stop, completion, or teardown.
- Mouse/touch blocking belongs to `#shield`; keyboard blocking belongs to
  `before-input-event` handlers on page and toolbar webContents.
- If you add a cursor-following output/thinking bubble, it belongs in the
  native overlay and must not bypass the shield pointer semantics.
- Screenshots hide the native overlay and clean temporary page overlays.
- Network-idle depends on webRequest inflight tracking, not only load events.
- Cleanup detaches CDP, releases window locks, closes popups, emits removal, and
  clears maps.
- Navigation policy and popup lifecycle must be ported, not just URL
  normalization; otherwise off-scope nav, `target=_blank`, and `window.open`
  misbehave.
- A custom deep-link scheme is intercepted before the pane loads it.
- The toolbar preload must be bundled to `.cjs`; it cannot be loaded as TS.
- Remote-aware callers use the async interface twins; sync forms are local-only.
- The tool description/help text is the agent's instruction surface and must be
  ported, not just the executor.

## Minimal API Surface For Another App

If the other app does not need all features, the smallest faithful surface is:

```ts
interface EmbeddedBrowserManager {
  createForSession(sessionId: string, options?: { show?: boolean }): string
  getOrCreateForSession(sessionId: string): string
  focusBoundForSession(sessionId: string): string
  listInstances(): BrowserInstanceInfo[]
  destroyInstance(id: string): void
  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: "none" | "navigation" | "network-idle"; timeoutMs?: number }): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number): Promise<void>
  fillElement(id: string, ref: string, value: string): Promise<void>
  typeText(id: string, text: string): Promise<void>
  selectOption(id: string, ref: string, value: string): Promise<void>
  screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>
  evaluate(id: string, expression: string): Promise<unknown>
  waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult>
}
```

But for a true 1:1 port, keep the full `IBrowserPaneManager` surface described
above.

## Validation Plan

For a port, validate these behaviors with real Electron, not only unit tests:

1. Open foreground and background browser windows.
2. Navigate to a normal website and a redirecting website.
3. Run `snapshot`, then `click`, `fill`, `select`, and `type`.
4. Verify refs break after page changes and require a new snapshot.
5. Capture raw screenshot and annotated screenshot.
6. Capture region by coordinates, ref, and selector.
7. Check `console`, `network failed`, and `wait network-idle`.
8. Download a file and confirm it auto-saves without native dialog.
9. Use two profiles and confirm cookies are isolated.
10. Run two sessions and confirm each gets its own owner-bound window.
11. Try to operate on another session's instance and confirm it is rejected.
12. Start an actionable browser tool and confirm the accent border, status chip,
    page shield, keyboard lock, and non-resizable window behavior.
13. Pause/stop/release the run and confirm the overlay disappears and user page
    interaction returns.
14. If you implement the cursor-following bubble, confirm it follows the cursor,
    never captures clicks, clamps to the viewport, and clears on release.
15. Open DevTools and confirm automation reports the debugger conflict.
16. Close a window via OS controls and confirm it hides unless explicitly
    destroyed.
17. Destroy a browser instance and confirm CDP detaches and state events fire.
18. Confirm navigation policy denies/externalizes as configured, `window.open`
    opens a tracked child window, and a custom scheme is routed away from the
    pane.
19. If remote agents exist, run the full remote invoke path and verify ownership
    namespace isolation.

## Common Porting Mistakes

- Using `shell.openExternal()` or the OS browser. That loses CDP, ownership,
  screenshots, downloads, and profile control.
- Injecting toolbar controls into the remote page. That breaks isolation and
  can be affected by site CSP/CSS.
- Implementing the agent lock as a React overlay in the main app window. It
  must be a native overlay view stacked above the page view.
- Adding cursor/thinking UI inside the remote page. It must live in the native
  overlay view, with `pointer-events: none`, while `#shield` blocks the page.
- Keeping CDP attached forever. This conflicts with DevTools and is easier for
  sites to detect.
- Using selectors as the primary tool interface. The design is
  accessibility-ref first.
- Returning live Electron objects over IPC. Always project to plain snapshots.
- Replacing session callbacks instead of merging them.
- Reusing manual windows for remote sessions.
- Forgetting to sanitize `Electron/` from the user agent.
- Treating `did-stop-loading` as network idle. Use webRequest inflight
  tracking.
- Allowing remote file upload without a separate file-transfer model.
- Forgetting to bundle the toolbar preload, then loading a TS path that fails
  silently and yields a blank toolbar.
- Calling sync `listInstances` / `getInstance` / `getOrCreateForSession` from the
  remote path instead of the async twins.
- Allowing every `window.open` (or denying all) instead of porting the
  http(s)-only child-window policy and popup tracking.
- Shipping app-specific recording/meeting IPC in a generic toolbar preload.
- Not wiring `setSessionPathResolver`, so downloads have nowhere deterministic to
  land.
- Porting the executor but not the tool description/help, leaving the agent with
  a tool it does not know how to drive.
