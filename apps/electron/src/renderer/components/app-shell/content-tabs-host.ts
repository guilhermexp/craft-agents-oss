import * as React from 'react'
import * as storage from '@/lib/local-storage'
import { contentTabsReducer, type ContentTabsAction, type ContentTabsState } from './content-tabs-state.ts'
import { readScopedContentTabs, type ContentTabsScope } from './content-tabs-scope.ts'
import {
  blockedFromReads,
  planPersist,
  type BlockedBuckets,
  type PersistPlan,
  type ReadOutcome,
} from './content-tabs-persistence.ts'

const EMPTY: ContentTabsState = { tabs: [], activeId: null }
const UNBLOCKED: BlockedBuckets = { object: false, file: false }

const objectSuffix = (workspaceId: string): string => `${workspaceId}:objects`
const fileSuffix = (workspaceId: string, sessionId: string): string => `${workspaceId}:${sessionId}:files`

/** A read that threw blocks its bucket; absent/corrupt reads stay writable. */
const outcome = (status: storage.ReadResult<unknown>['status']): ReadOutcome =>
  status === 'failed' ? 'failed' : 'ok'

/** Write a plan's non-null buckets to the two localStorage keys for a scope. */
function applyPlan(scope: ContentTabsScope, plan: PersistPlan): void {
  if (plan.object) storage.set(storage.KEYS.workspaceObjectTabs, plan.object, objectSuffix(scope.workspaceId))
  if (plan.file && scope.sessionId) {
    storage.set(storage.KEYS.workspaceObjectTabs, plan.file, fileSuffix(scope.workspaceId, scope.sessionId))
  }
}

/**
 * Own the right-sidebar content tabs for a workspace/session scope.
 *
 * The hook holds the reducer state and restores it from localStorage whenever
 * the scope changes. Persistence rides on user intent rather than on a state
 * effect: the returned dispatch writes the resulting state back synchronously,
 * under the scope that is on screen, before React can batch a scope switch that
 * would relocate the buckets. That keeps an outgoing scope's last mutation from
 * being flushed into the incoming scope (or lost), makes the restore dispatch
 * the one action that never writes (so a freshly-read state is never echoed
 * back over the bucket it came from), and — because effects never write — stays
 * correct under StrictMode's double-invoked mount.
 *
 * A bucket whose read failed is held blocked until a later read of the same
 * scope succeeds, so a transient localStorage failure cannot overwrite intact
 * bytes with the empty fallback it forced. Live browser tabs survive a restore
 * in memory (the reducer keeps them) but never reach storage.
 */
export function useContentTabs(
  workspaceId: string | null,
  sessionId: string | null,
): { state: ContentTabsState; dispatch: React.Dispatch<ContentTabsAction> } {
  const [state, dispatch] = React.useReducer(contentTabsReducer, EMPTY)

  // Live mirrors the wrapped dispatch reads so a mutation persists synchronously
  // under the on-screen scope, ahead of any batched scope switch.
  const stateRef = React.useRef(state)
  stateRef.current = state
  const scopeRef = React.useRef<ContentTabsScope | null>(null)
  const blockedRef = React.useRef<BlockedBuckets>(UNBLOCKED)

  React.useEffect(() => {
    if (!workspaceId) {
      scopeRef.current = null
      blockedRef.current = UNBLOCKED
      dispatch({ type: 'restore', state: EMPTY })
      return
    }
    const scope: ContentTabsScope = { workspaceId, sessionId }
    const objectRead = storage.read<ContentTabsState>(storage.KEYS.workspaceObjectTabs, objectSuffix(workspaceId))
    const fileRead = sessionId
      ? storage.read<ContentTabsState>(storage.KEYS.workspaceObjectTabs, fileSuffix(workspaceId, sessionId))
      : null
    const object = objectRead.status === 'present' ? objectRead.value : EMPTY
    const file = fileRead && fileRead.status === 'present' ? fileRead.value : EMPTY
    scopeRef.current = scope
    blockedRef.current = blockedFromReads(outcome(objectRead.status), fileRead ? outcome(fileRead.status) : null)
    dispatch({ type: 'restore', state: readScopedContentTabs(scope, { object, file }) })
  }, [workspaceId, sessionId])

  const persistDispatch = React.useCallback((action: ContentTabsAction) => {
    // The restore action is the hook's own load; persisting it would echo the
    // freshly-read (or fallback) state straight back over the bucket. Only user
    // intent mutates storage, and it does so under the scope showing now.
    if (action.type !== 'restore') {
      const next = contentTabsReducer(stateRef.current, action)
      stateRef.current = next
      const scope = scopeRef.current
      if (scope) applyPlan(scope, planPersist(scope, next, blockedRef.current))
    }
    dispatch(action)
  }, [])

  return { state, dispatch: persistDispatch }
}
