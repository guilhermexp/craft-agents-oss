import { serializeScopedContentTabs, type ContentTabsScope } from './content-tabs-scope.ts'
import type { ContentTabsState } from './content-tabs-state.ts'

/**
 * Whether a scope's two persisted buckets are currently unwritable because
 * their last read failed.
 *
 * A read failure (the backend threw) forces the hook to fall back to an empty
 * bucket in memory. Writing that empty fallback back would clobber whatever
 * bytes are still on disk, so a bucket stays blocked from the moment its read
 * fails until a later read of the same bucket succeeds.
 */
export interface BlockedBuckets {
  /** Object bucket read failed: object writes are suppressed. */
  object: boolean
  /** File bucket read failed: file writes are suppressed. */
  file: boolean
}

/** A single bucket read reduced to whether it failed. */
export type ReadOutcome = 'ok' | 'failed'

/**
 * Derive the blocked set from the two bucket reads. Only a genuine backend
 * failure blocks a bucket; `absent` and `corrupt` reads are safely writable and
 * map to `ok`. A `null` file outcome means the scope has no file bucket.
 */
export function blockedFromReads(object: ReadOutcome, file: ReadOutcome | null): BlockedBuckets {
  return { object: object === 'failed', file: file === 'failed' }
}

/**
 * The buckets to write for a scope's live state. A `null` bucket must not be
 * written: either the scope has no file bucket or that bucket is blocked.
 */
export interface PersistPlan {
  object: ContentTabsState | null
  file: ContentTabsState | null
}

/**
 * Split live tab state into the buckets to persist for `scope`, dropping any
 * bucket whose read failed.
 *
 * `serializeScopedContentTabs` already keeps only the tabs that belong to the
 * scope (browser tabs and foreign-scope tabs never reach a bucket), so planning
 * against a state that still holds another scope's tabs cannot leak them. The
 * blocked check then removes any bucket that is unsafe to overwrite, so a
 * transient read failure never replaces stored data with the empty fallback it
 * forced.
 */
export function planPersist(
  scope: ContentTabsScope,
  state: ContentTabsState,
  blocked: BlockedBuckets,
): PersistPlan {
  const { object, file } = serializeScopedContentTabs(scope, state)
  return {
    object: blocked.object ? null : object,
    file: file !== null && !blocked.file ? file : null,
  }
}
