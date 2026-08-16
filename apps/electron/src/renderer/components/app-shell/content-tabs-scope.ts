import { restoreContentTabs, type ContentTab, type ContentTabsState } from './content-tabs-state.ts'

/**
 * The workspace/session a set of content tabs belongs to.
 *
 * A `null` session means the workspace is showing no session, so no file
 * bucket exists: files are always scoped to a session, objects only to a
 * workspace.
 */
export interface ContentTabsScope {
  workspaceId: string
  sessionId: string | null
}

/** Coerce an untrusted persisted bucket into the two fields the reader reads. */
function coerceBucket(value: unknown): { tabs: unknown[]; activeId: unknown } {
  if (!value || typeof value !== 'object') return { tabs: [], activeId: null }
  const bucket = value as { tabs?: unknown; activeId?: unknown }
  return { tabs: Array.isArray(bucket.tabs) ? bucket.tabs : [], activeId: bucket.activeId }
}

/**
 * Rebuild the in-memory tab state for a scope from its two persisted buckets.
 *
 * Objects come first, then files, and the file bucket's selection wins so a
 * file the user last looked at stays active over an object. The object bucket
 * is workspace-scoped; the file bucket only applies when the scope has a
 * session. `restoreContentTabs` performs identity canonicalization, scope
 * filtering and active repair, so a bucket persisted for one scope cannot leak
 * into another and corrupt input collapses to an empty state.
 */
export function readScopedContentTabs(
  scope: ContentTabsScope,
  buckets: { object: unknown; file: unknown },
): ContentTabsState {
  const object = coerceBucket(buckets.object)
  const file = scope.sessionId ? coerceBucket(buckets.file) : { tabs: [], activeId: null }
  const merged = {
    tabs: [...object.tabs, ...file.tabs],
    activeId: file.activeId ?? object.activeId,
  }
  return restoreContentTabs(merged, scope.workspaceId, scope.sessionId)
}

/** A bucket claims the active id only when it owns the tab that holds it. */
function claimActive(tabs: ContentTab[], activeId: string | null): ContentTabsState {
  return { tabs, activeId: activeId !== null && tabs.some(tab => tab.id === activeId) ? activeId : null }
}

/**
 * Split the in-memory tab state into the two persistable buckets for a scope.
 *
 * Only tabs belonging to this scope are written: objects to the object bucket,
 * files to the file bucket. Browser tabs are live handles and are never
 * persisted, so an active browser tab leaves both buckets without a selection.
 * A scope with no session has no file bucket.
 */
export function serializeScopedContentTabs(
  scope: ContentTabsScope,
  state: ContentTabsState,
): { object: ContentTabsState; file: ContentTabsState | null } {
  const objectTabs = state.tabs.filter(
    tab => tab.target.kind === 'object' && tab.target.workspaceId === scope.workspaceId,
  )
  const object = claimActive(objectTabs, state.activeId)
  if (!scope.sessionId) return { object, file: null }
  const fileTabs = state.tabs.filter(
    tab =>
      tab.target.kind === 'file'
      && tab.target.workspaceId === scope.workspaceId
      && tab.target.sessionId === scope.sessionId,
  )
  return { object, file: claimActive(fileTabs, state.activeId) }
}
