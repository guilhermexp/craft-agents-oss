# Deepen Four Core Modules — Approved Design

**Date:** 2026-08-15  
**Status:** Approved

## Goal

Deepen four recently changed modules so callers declare intent while ordering, lifecycle and failure policy stay behind the correct seam. Preserve observable behavior and existing security/domain invariants. Use clean cutovers: migrate every caller and remove obsolete callbacks, flags and wrappers.

## 1. Source readiness

### Decision

Create one transactional entry point in `packages/session-tools-core/src/handlers/source-readiness.ts`:

```ts
resolveSourceReadiness(
  request: SourceReadinessRequest,
  session: SessionSourceReadiness,
): Promise<SourceReadinessOutcome>
```

`SessionSourceReadiness` replaces the eight readiness members currently copied through `SessionToolContext`, `SessionScopedToolCallbacks`, late-bound properties and `SessionManager`:

```ts
interface SessionSourceReadiness {
  readonly backend: SourceProbeBackend;
  probeSourceTools(sourceSlug: string): Promise<SourceProbeOutcome>;
  activateSource(sourceSlug: string, persistReady: () => void): Promise<SourceActivationOutcome>;
  persistSourceConfig(source: SourceConfig): void;
}
```

The module owns identity validation, source-test gating, probe verdict, staged-unhealthy persistence, activation, ready persistence, redacted reporting and stable reason mapping. The server-core adapter owns live session exposure and compensation. Existing persisted reason vocabulary remains unchanged.
Activation failures carry a closed, transient diagnostic (`exposure-failed`, `commit-failed` or `ready-persist-failed`) so the tool preserves distinct operator messages without widening persisted readiness reasons. An absent late-bound seam is represented by an unsupported adapter that still persists fail-closed health.

### Invariants

- Cleanup completes before health persistence.
- Staged unhealthy state is durable before exposure.
- Ready state is durable only after commit.
- Every activation failure attempts restoration and remains unhealthy.
- Claude, Codex and Hermes observe the same shared-pool toolset.
- Logs and public results contain only stable reason codes and portable tool identities.
- Legacy sources without `expectedTools` retain the existing next-turn activation path.

## 2. Workspace objects

### Decision

Replace repeated `WorkspaceObjectService.open/execute/close` callers with lifecycle-owning functions in the shared Workspace objects module:

```ts
executeWorkspaceObjectAction(options, action, onEvent?): WorkspaceObjectServiceResult
repairWorkspaceObjectProjections(options, changedPath?, onEvent?): void
```

Replace the per-call in-process event bus with a server-core `WorkspaceObjectEventFeed`. The feed owns the existing refcounted watcher, receives both immediate local events and durable `.events` markers, and deduplicates per subscribed client by `workspaceId/objectId/revision/projectionStatus`.

Normal events keep the existing EVENT channel and `WorkspaceObjectEvent` shape. Watcher recovery emits a separate internal RELOAD channel. `bindWorkspaceObjectSubscription` consumes it and calls the existing renderer reload bus, so AppShell's callsite stays unchanged.

### Invariants

- SQLite commits first.
- Exactly one post-commit event is formed as `ready` or `projection-error`.
- Durable projection failure still delivers the in-process `projection-error` event.
- Durable and local adapters cannot double-deliver the same event to a client.
- Watcher recovery triggers projection reconciliation and client reload, then re-arms while subscribers remain.
- Inbound remote events are translated back to local workspace identity, and unsubscribe returns to the client/remote ID that accepted subscribe.
- One watcher exists per workspace and closes after the last subscriber; stale handles and stale renderer bindings cannot tear down their replacements.
- Claude, Hermes/session MCP and Desktop RPC execute through the same shared function.
- No repository cache, idle eviction or new storage seam is introduced.

## 3. Content tabs

### Decision

Keep `content-tabs-state.ts` as the identity/reducer module. Add:

- `content-tabs-scope.ts`: pure scope, bucket, restore/merge, active selection and serialization policy.
- `content-tabs-persistence.ts`: pure write planning and per-bucket suppression after failed reads.
- `content-tabs-host.ts`: thin React/localStorage adapter exposing `useContentTabs(workspaceId, sessionId)`.

AppShell keeps render and user intent dispatch. It no longer owns storage keys, bucket suffixes, merge precedence, restore/persist effects or `restoringRightSidebarTabsRef`. The host persists user actions synchronously under the scope that produced them, before a batched scope switch can relocate or lose the outgoing state. A typed local-storage read distinguishes transient backend failure from absent/corrupt data and blocks only the affected bucket until a later successful read.

### Invariants

- File identity includes workspace/session/path.
- Object identity includes workspace/object/view.
- Browser handles survive in-memory scope restoration but never persist.
- File and object buckets remain byte-compatible; no migration or shim.
- Active selection precedence and repair remain deterministic.
- Preview, pinned, permanent and retarget semantics remain unchanged.
- A failed storage read never writes an empty fallback over recoverable bytes.
- A user action batched with scope switch or unmount persists under the outgoing scope.
- No generic storage adapter or external state store is introduced.
- Existing user changes in `AppShell.tsx` must be preserved with minimal hunks.

## 4. Cookie import

### Decision

Delete the hypothetical agent/user variation. Keep the behavior in `BrowserPaneManager`; do not add a new module:

```ts
previewCookieImport(profileId: string): Promise<BrowserCookieImportPreview>
importCookies(profileId: string): Promise<BrowserCookieImportResult>
```

Both methods resolve a known user-only profile before reading or writing. They throw one typed refusal consumed by the RPC reason-code mapper. Delete `callerIntent`, `domain`, the duplicate handler guard and agent-intent tests.

### Invariants

- Feature remains user-only and local-only.
- Unknown and non-user-only profile IDs fail before reader/partition access.
- Default sensitive-host denylist runs before decryption.
- Decrypted values remain in memory only for the read.
- RPC/UI results remain counts-only.
- Raw errors, cookie values and host names never cross the seam.
- Failure logs contain static operation context and the stable reason code only; caller-supplied profile IDs are not logged.
- Chrome reader and Electron cookie jar remain the two real adapters; no new abstraction wraps them.

## Rejected alternatives

- Source readiness callbacks exposed as lifecycle verbs: shallow interface; ordering remains caller knowledge.
- Per-backend readiness adapters: the current probe does not branch by backend; hypothetical seam.
- Cached Workspace object repositories with idle eviction: new lifetime and failure policy without a demonstrated requirement.
- Generic Content tabs storage ports: only one real persistence adapter exists.
- Dedicated Cookie import module: moves a small method pair without concentrating additional complexity.

## Verification

Each module receives a contract test before production edits. After implementation, run focused tests for the four modules, then `bun run typecheck:all`, `bun run lint:tool-contracts`, `bun run lint:i18n:parity`, strict OpenSpec validation where affected, and `git diff --check`.
