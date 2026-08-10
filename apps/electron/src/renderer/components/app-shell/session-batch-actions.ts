/**
 * session-batch-actions
 *
 * Pure helpers behind the multi-select session menus (BatchSessionMenu). Two groups:
 *
 * - compute* — derive shared UI state from the selected session metadata
 *   (shared status, applied-label intersection, all-flagged, label toggle plan).
 * - applyBatch* / applyLabelToggle — dispatch a batch mutation through the
 *   SessionActions seam (or the workspace label callback).
 *
 * Keeping these off the component lets a test drive them with a hand-built
 * SessionActions stub (14 fields) instead of the full provider value.
 */

import type { SessionActions } from '@/context/AppShellContext'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatusId } from '@/config/session-status-config'
import { extractLabelId } from '@craft-agent/shared/labels'

/** The subset of session metadata the batch computations read. */
export type SessionBatchMeta = Pick<SessionMeta, 'id' | 'sessionStatus' | 'labels' | 'isFlagged'>

/** A per-session label array to persist (result of a batch label toggle). */
export interface SessionLabelUpdate {
  id: string
  labels: string[]
}

/**
 * The single status shared by every selected session, or null when the selection
 * is empty or mixed. Sessions without a status default to 'todo'.
 */
export function computeSharedSessionStatus(metas: SessionBatchMeta[]): SessionStatusId | null {
  if (metas.length === 0) return null
  const first = (metas[0].sessionStatus || 'todo') as SessionStatusId
  const allSame = metas.every(meta => (meta.sessionStatus || 'todo') === first)
  return allSame ? first : null
}

/** Label ids applied to *every* selected session (set intersection). */
export function computeAppliedLabelIds(metas: SessionBatchMeta[]): Set<string> {
  if (metas.length === 0) return new Set<string>()
  const labelSets = metas.map(meta => new Set((meta.labels || []).map(entry => extractLabelId(entry))))
  const [first, ...rest] = labelSets
  const intersection = new Set(first)
  for (const labelSet of rest) {
    for (const id of [...intersection]) {
      if (!labelSet.has(id)) intersection.delete(id)
    }
  }
  return intersection
}

/** True when the selection is non-empty and every session is flagged. */
export function areAllSessionsFlagged(metas: SessionBatchMeta[]): boolean {
  return metas.length > 0 && metas.every(meta => meta.isFlagged)
}

/**
 * Plan an all-or-nothing label toggle across the selection: if every session
 * already carries the label, remove it from all; otherwise add it to those
 * missing it. Returns the next label array for every session — unchanged ones
 * included, matching the existing per-session persist behavior.
 */
export function computeLabelToggleUpdates(metas: SessionBatchMeta[], labelId: string): SessionLabelUpdate[] {
  const allHaveLabel = metas.every(meta =>
    (meta.labels || []).some(entry => extractLabelId(entry) === labelId)
  )
  return metas.map(meta => {
    const currentLabels = meta.labels || []
    const hasLabel = currentLabels.some(entry => extractLabelId(entry) === labelId)
    const nextLabels = allHaveLabel
      ? currentLabels.filter(entry => extractLabelId(entry) !== labelId)
      : (hasLabel ? currentLabels : [...currentLabels, labelId])
    return { id: meta.id, labels: nextLabels }
  })
}

/** Apply a status to every session in the batch. */
export function applyBatchStatus(
  onSessionStatusChange: SessionActions['onSessionStatusChange'],
  sessionIds: Iterable<string>,
  status: Parameters<SessionActions['onSessionStatusChange']>[1],
): void {
  for (const id of sessionIds) onSessionStatusChange(id, status)
}

/** Flag every session in the batch. */
export function applyBatchFlag(onFlagSession: SessionActions['onFlagSession'], sessionIds: Iterable<string>): void {
  for (const id of sessionIds) onFlagSession(id)
}

/** Unflag every session in the batch. */
export function applyBatchUnflag(onUnflagSession: SessionActions['onUnflagSession'], sessionIds: Iterable<string>): void {
  for (const id of sessionIds) onUnflagSession(id)
}

/** Archive every session in the batch. */
export function applyBatchArchive(onArchiveSession: SessionActions['onArchiveSession'], sessionIds: Iterable<string>): void {
  for (const id of sessionIds) onArchiveSession(id)
}

/** Persist a planned label toggle through the workspace label callback. */
export function applyLabelToggle(
  onSessionLabelsChange: (sessionId: string, labels: string[]) => void,
  metas: SessionBatchMeta[],
  labelId: string,
): void {
  for (const update of computeLabelToggleUpdates(metas, labelId)) {
    onSessionLabelsChange(update.id, update.labels)
  }
}

/**
 * Delete a batch of sessions. The first deletion goes through the normal
 * confirmation flow; if the user confirms, the rest are deleted concurrently
 * with confirmation skipped. Returns false (deleting nothing further) when the
 * selection is empty or the user cancels the first prompt.
 */
export async function applyBatchDelete(onDeleteSession: SessionActions['onDeleteSession'], sessionIds: string[]): Promise<boolean> {
  if (sessionIds.length === 0) return false
  const [first, ...rest] = sessionIds
  const firstDeleted = await onDeleteSession(first)
  if (!firstDeleted) return false
  await Promise.all(rest.map(id => onDeleteSession(id, true)))
  return true
}
