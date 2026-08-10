import { describe, it, expect, mock } from 'bun:test'
import type { SessionActions } from '@/context/AppShellContext'
import {
  computeSharedSessionStatus,
  computeAppliedLabelIds,
  areAllSessionsFlagged,
  computeLabelToggleUpdates,
  applyBatchStatus,
  applyBatchFlag,
  applyBatchDelete,
  applyLabelToggle,
  type SessionBatchMeta,
} from './session-batch-actions'

/**
 * Build a SessionActions value from 14 recording spies. This is the seam the
 * refactor unlocks: exercising session mutations no longer needs the full
 * AppShell provider (65 fields) — the 14-field SessionActions interface is the
 * entire surface, and it is constructible by hand.
 */
function createSessionActionsStub(
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean> = () => Promise.resolve(true),
) {
  const spies = {
    onCreateSession: mock(() => Promise.reject(new Error('onCreateSession not stubbed'))),
    onSendMessage: mock(() => {}),
    onRenameSession: mock(() => {}),
    onFlagSession: mock<SessionActions['onFlagSession']>(() => {}),
    onUnflagSession: mock(() => {}),
    onArchiveSession: mock(() => {}),
    onUnarchiveSession: mock(() => {}),
    onMarkSessionRead: mock(() => {}),
    onMarkSessionUnread: mock(() => {}),
    onSetActiveViewingSession: mock(() => {}),
    onSessionStatusChange: mock<SessionActions['onSessionStatusChange']>(() => {}),
    onDeleteSession: mock(onDelete),
    onRespondToPermission: mock(() => {}),
    onRespondToCredential: mock(() => {}),
  }
  const actions: SessionActions = spies
  return { actions, spies }
}

function meta(id: string, extra: Partial<SessionBatchMeta> = {}): SessionBatchMeta {
  return { id, ...extra }
}

describe('applyBatch* dispatch through a SessionActions stub', () => {
  it('applyBatchStatus fires onSessionStatusChange once per id, nothing else', () => {
    const { actions, spies } = createSessionActionsStub()
    applyBatchStatus(actions.onSessionStatusChange, ['a', 'b', 'c'], 'done')
    expect(spies.onSessionStatusChange.mock.calls).toEqual([
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'done'],
    ])
    expect(spies.onDeleteSession).not.toHaveBeenCalled()
    expect(spies.onFlagSession).not.toHaveBeenCalled()
  })

  it('applyBatchFlag flags every id', () => {
    const { actions, spies } = createSessionActionsStub()
    applyBatchFlag(actions.onFlagSession, ['x', 'y'])
    expect(spies.onFlagSession.mock.calls).toEqual([['x'], ['y']])
  })

  it('applyBatchDelete confirms the first, then skips confirmation for the rest', async () => {
    const { actions, spies } = createSessionActionsStub()
    const deleted = await applyBatchDelete(actions.onDeleteSession, ['a', 'b', 'c'])
    expect(deleted).toBe(true)
    expect(spies.onDeleteSession.mock.calls).toEqual([
      ['a'],
      ['b', true],
      ['c', true],
    ])
  })

  it('applyBatchDelete stops when the first deletion is cancelled', async () => {
    const { actions, spies } = createSessionActionsStub(() => Promise.resolve(false))
    const deleted = await applyBatchDelete(actions.onDeleteSession, ['a', 'b', 'c'])
    expect(deleted).toBe(false)
    expect(spies.onDeleteSession.mock.calls).toEqual([['a']])
  })

  it('applyBatchDelete does nothing on an empty selection', async () => {
    const { actions, spies } = createSessionActionsStub()
    const deleted = await applyBatchDelete(actions.onDeleteSession, [])
    expect(deleted).toBe(false)
    expect(spies.onDeleteSession).not.toHaveBeenCalled()
  })
})

describe('computeSharedSessionStatus', () => {
  it('returns null for an empty selection', () => {
    expect(computeSharedSessionStatus([])).toBeNull()
  })

  it('returns the shared status when all sessions match', () => {
    expect(
      computeSharedSessionStatus([meta('a', { sessionStatus: 'done' }), meta('b', { sessionStatus: 'done' })]),
    ).toBe('done')
  })

  it('defaults a missing status to todo', () => {
    expect(computeSharedSessionStatus([meta('a'), meta('b', { sessionStatus: 'todo' })])).toBe('todo')
  })

  it('returns null when statuses differ', () => {
    expect(
      computeSharedSessionStatus([meta('a', { sessionStatus: 'done' }), meta('b', { sessionStatus: 'todo' })]),
    ).toBeNull()
  })
})

describe('computeAppliedLabelIds', () => {
  it('is empty for an empty selection', () => {
    expect(computeAppliedLabelIds([]).size).toBe(0)
  })

  it('keeps only labels present on every session', () => {
    const result = computeAppliedLabelIds([
      meta('a', { labels: ['urgent', 'backend'] }),
      meta('b', { labels: ['urgent'] }),
    ])
    expect([...result]).toEqual(['urgent'])
  })
})

describe('areAllSessionsFlagged', () => {
  it('is false for an empty selection', () => {
    expect(areAllSessionsFlagged([])).toBe(false)
  })

  it('is true only when every session is flagged', () => {
    expect(areAllSessionsFlagged([meta('a', { isFlagged: true }), meta('b', { isFlagged: true })])).toBe(true)
    expect(areAllSessionsFlagged([meta('a', { isFlagged: true }), meta('b', { isFlagged: false })])).toBe(false)
  })
})

describe('computeLabelToggleUpdates', () => {
  it('adds the label to sessions missing it when only some have it', () => {
    const updates = computeLabelToggleUpdates(
      [meta('a', { labels: ['urgent'] }), meta('b', { labels: [] })],
      'urgent',
    )
    expect(updates).toEqual([
      { id: 'a', labels: ['urgent'] },
      { id: 'b', labels: ['urgent'] },
    ])
  })

  it('removes the label from all when every session already has it', () => {
    const updates = computeLabelToggleUpdates(
      [meta('a', { labels: ['urgent', 'backend'] }), meta('b', { labels: ['urgent'] })],
      'urgent',
    )
    expect(updates).toEqual([
      { id: 'a', labels: ['backend'] },
      { id: 'b', labels: [] },
    ])
  })
})

describe('applyLabelToggle', () => {
  it('persists each computed update via the label callback', () => {
    const onSessionLabelsChange = mock((_sessionId: string, _labels: string[]) => {})
    applyLabelToggle(onSessionLabelsChange, [meta('a', { labels: [] }), meta('b', { labels: [] })], 'urgent')
    expect(onSessionLabelsChange.mock.calls).toEqual([
      ['a', ['urgent']],
      ['b', ['urgent']],
    ])
  })
})
