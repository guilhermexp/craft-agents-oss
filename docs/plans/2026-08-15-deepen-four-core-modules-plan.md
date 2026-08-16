# Deepen Four Core Modules — Implementation Plan

> Execute with four isolated problem owners. Tests are written before production edits. Agents do not run project validation; the orchestrator runs RED/GREEN and final gates once per wave.

**Goal:** Implement the approved deep-module design in `2026-08-15-deepen-four-core-modules-design.md` with clean cutovers and preserved observable behavior.

**Constraints:** Preserve all `AGENTS.md` invariants. Do not commit. Do not overwrite unrelated dirty work; `AppShell.tsx` is already modified. No shims, deprecated aliases, speculative adapters, repository cache or new public reason vocabulary.

## Wave A — Contract tests (RED)

### A1. Source readiness contract

**Files**
- Add: `packages/session-tools-core/src/handlers/source-readiness-module.test.ts`
- Reference: existing `source-readiness*.test.ts`

**Test**
- Import `resolveSourceReadiness` and `SessionSourceReadiness` from the intended module.
- Drive one success and one activation failure with a seam fake.
- Assert observable order: staged unhealthy persistence → probe/cleanup → activation commit → ready persistence.
- Assert failure never persists ready and returns an existing stable `SourceReadinessReason`.

**RED command**
```bash
bun test packages/session-tools-core/src/handlers/source-readiness-module.test.ts
```
Expected failure: module/export does not exist.

### A2. Workspace objects lifecycle/feed contracts

**Files**
- Add: `packages/shared/src/workspace-objects/__tests__/service-lifecycle.test.ts`
- Add: `packages/server-core/src/workspace-objects/workspace-object-event-feed.test.ts`

**Tests**
- Shared runner opens canonical state, executes a mutation, emits one event and closes resources.
- Feed receives the same event through local and durable adapters but delivers once per client.
- Same revision `projection-error → ready` is delivered; exact duplicate and older revision are ignored.
- Watcher recovery produces reload and releases watcher state.

**RED commands**
```bash
bun test packages/shared/src/workspace-objects/__tests__/service-lifecycle.test.ts
bun test packages/server-core/src/workspace-objects/workspace-object-event-feed.test.ts
```
Expected failure: runner/feed exports do not exist.

### A3. Content tabs scope contract

**Files**
- Add: `apps/electron/src/renderer/components/app-shell/__tests__/content-tabs-scope.test.ts`

**Test**
- Read/merge object and file buckets with file-active precedence.
- Serialize only targets belonging to the current scope.
- Never serialize browser targets.
- A state restored for one scope cannot overwrite another scope.
- Corrupt storage input falls back to an empty scoped state.

**RED command**
```bash
bun test apps/electron/src/renderer/components/app-shell/__tests__/content-tabs-scope.test.ts
```
Expected failure: scope module does not exist.

### A4. Cookie import deletion contract

**Files**
- Update: `apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
- Update: `apps/electron/src/main/handlers/__tests__/browser-cookie-import.test.ts`

**Test changes**
- Call preview/import with `profileId` only.
- Keep unknown-profile and non-user-only refusals with zero reader/partition effects.
- Delete agent-intent/domain cases.
- Keep counts-only, denylist and per-row write-failure behavior.

**RED command**
```bash
bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts apps/electron/src/main/handlers/__tests__/browser-cookie-import.test.ts
```
Expected failure: old production signatures/gates do not satisfy the new calls and typed refusal.

## Wave B — Production implementation (GREEN)

### B1. Deepen Source readiness

**Files**
- Add: `packages/session-tools-core/src/handlers/source-readiness.ts`
- Modify: `packages/session-tools-core/src/handlers/source-test.ts`
- Modify: `packages/session-tools-core/src/context.ts`
- Modify: `packages/session-tools-core/src/index.ts`
- Modify: `packages/shared/src/agent/session-scoped-tool-callback-registry.ts`
- Modify: `packages/shared/src/agent/session-self-management-bindings.ts`
- Modify: `packages/server-core/src/sessions/SessionManager.ts`
- Update focused readiness/binding tests.

**Steps**
1. Move verdict, persistence and reporting into `resolveSourceReadiness` without changing stable outcomes.
2. Define one `SessionSourceReadiness` seam and atomic probe/activation outcome types.
3. Replace eight context/registry/binding members with one late-bound object.
4. Build the sole production adapter in `SessionManager`; move rollback bookkeeping into its closure.
5. Replace the inline readiness transaction in `source-test.ts` with one call.
6. Remove obsolete exported dependency records, guards and tests of partial wiring.

### B2. Deepen Workspace object lifecycle/events

**Files**
- Modify: `packages/shared/src/workspace-objects/service.ts`
- Modify: `packages/shared/src/workspace-objects/index.ts`
- Modify/remove: `packages/shared/src/workspace-objects/events.ts`
- Modify: `packages/shared/src/workspace-objects/event-projection.ts`
- Add: `packages/server-core/src/workspace-objects/workspace-object-event-feed.ts`
- Modify: `packages/server-core/src/handlers/rpc/workspace-objects.ts`
- Modify: `packages/server-core/src/workspace-objects/workspace-object-watcher.ts` only if required by feed ownership.
- Modify: `packages/shared/src/agent/claude-context.ts`
- Modify: `packages/session-mcp-server/src/index.ts`
- Modify protocol/preload/shared types only for the internal RELOAD channel.
- Modify: `apps/electron/src/renderer/components/app-shell/workspace-object-reconnect.ts`
- Update focused Workspace object tests.

**Steps**
1. Add lifecycle-owning execute/repair functions; preserve SQLite→manifest→durable projection→local sink ordering.
2. Replace EventBus with an optional post-commit sink used by the feed.
3. Implement feed subscription, local/durable ingestion, per-client revision/status dedupe, reload and teardown.
4. Route LIST/EXECUTE/SUBSCRIBE/UNSUBSCRIBE through the new module/feed.
5. Migrate Claude and session MCP callers to the shared runner.
6. Wire watcher recovery to an internal RELOAD channel consumed by the existing renderer reload bus.
7. Remove every direct `WorkspaceObjectService.open` production caller and obsolete event-bus lifecycle.

### B3. Deepen Content tabs persistence

**Files**
- Add: `apps/electron/src/renderer/components/app-shell/content-tabs-scope.ts`
- Add: `apps/electron/src/renderer/components/app-shell/content-tabs-host.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/content-tabs-state.ts`
- Modify minimally: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Update: `apps/electron/src/renderer/components/app-shell/__tests__/content-tabs-state.test.ts`

**Steps**
1. Define `ContentTabsScope` and scoped state/bucket helpers as pure functions.
2. Preserve persisted bucket bytes and existing restore aliases.
3. Implement the thin React/localStorage adapter with one public hook.
4. Replace AppShell's reducer + two effects + latch with the hook; leave rendering/intent dispatch unchanged.
5. Preserve all unrelated AppShell modifications and do not reformat the file.

### B4. Delete Cookie import intent

**Files**
- Modify: `apps/electron/src/main/browser-pane-manager.ts`
- Modify: `apps/electron/src/main/handlers/browser.ts`
- Update focused tests and `openspec/changes/add-browser-cookie-import/tasks.md`/repo contract wording that names `callerIntent`.

**Steps**
1. Change preview/import to accept only `profileId`.
2. Move the single known+user-only gate to `BrowserPaneManager` with one typed refusal.
3. Delete `callerIntent`, `domain`, owner-type ternaries and duplicate handler profile scan.
4. Keep partition resolution, reader options, SameSite mapping, `Promise.allSettled` and counts-only result unchanged.
5. Map typed refusal to `user-only-required`; log reason code only.
6. Delete tests that exercised the cancelled agent-facing path.

## Wave C — Review and verification

### C1. Cross-module review

- Run a code-review agent over the combined diff.
- Run a silent-failure review for Source readiness, Workspace event fallback and cookie import error mapping.
- Resolve only evidence-backed findings; do not broaden scope.

### C2. Focused GREEN

```bash
bun test packages/session-tools-core/src/handlers/source-readiness*.test.ts \
  packages/shared/src/agent/__tests__/source-readiness-bindings.test.ts \
  packages/server-core/src/sessions/session-source-readiness-probe*.test.ts

bun test packages/shared/src/workspace-objects/__tests__/*.test.ts \
  packages/server-core/src/workspace-objects/*.test.ts \
  apps/electron/src/renderer/components/right-sidebar/__tests__/workspace-objects-section.test.ts

bun test apps/electron/src/renderer/components/app-shell/__tests__/content-tabs-state.test.ts \
  apps/electron/src/renderer/components/app-shell/__tests__/content-tabs-scope.test.ts

bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts \
  apps/electron/src/main/handlers/__tests__/browser-cookie-import.test.ts \
  packages/shared/src/browser-cookies/*.test.ts
```

### C3. Repository gates

```bash
bun run typecheck:all
bun run lint:tool-contracts
bun run lint:i18n:parity
bunx openspec validate --strict
git diff --check
```

### C4. Cleanup

- Update `AGENTS.md` only where the old callerIntent or event lifecycle wording is now false.
- Update `apps/electron/docs/channels-war-room.md` only if untouched channel contracts changed; otherwise leave it alone.
- Update relevant OpenSpec task evidence, not archived specs.
- Remove obsolete exports, tests, callbacks, imports and comments.
- Do not commit or stage the user's existing work.
