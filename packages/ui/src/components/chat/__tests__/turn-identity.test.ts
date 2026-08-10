/**
 * The Turn identity must be stable across a turn's whole lifecycle, and the
 * card's persisted expansion is keyed off that identity. The regression this
 * guards: `response.messageId` arriving mid-stream used to change the expansion
 * key (getAssistantTurnUiKey flipped from `assistant:turn:...` to
 * `assistant:msg:...`) while the React node's key (turn-${turnId}-${timestamp})
 * did not — so the card silently reverted to its default expansion. There is now
 * ONE identity (getTurnKey) used for both, so the transition is a no-op.
 */

import { describe, it, expect } from 'bun:test'
import { getTurnKey, groupMessagesByTurn, type AssistantTurn, type Turn } from '../turn-utils'
import { isIdExpanded, applyExpansionToggle, type ExpansionState } from '../turn-expansion'
import type { Message } from '@craft-agent/core'

const TURN_ID = 'turn-x'

const userMsg: Message = { id: 'user-1', role: 'user', content: 'hi', timestamp: 900 }
const toolRunning: Message = {
  id: 'tool-1', role: 'tool', content: '', timestamp: 1000,
  toolName: 'Read', toolUseId: 'tu-1', turnId: TURN_ID,
}
const toolDone: Message = {
  ...toolRunning, content: 'result', toolStatus: 'completed', toolResult: 'result',
}
const finalAssistant: Message = {
  id: 'assistant-final-1', role: 'assistant', content: 'All done.',
  timestamp: 2000, isStreaming: false, turnId: TURN_ID,
}

/** Tools still running: the turn has no final response, so response.messageId is absent. */
const beforeMessageId: Message[] = [userMsg, toolRunning]
/** The final response message has landed, carrying response.messageId. */
const afterMessageId: Message[] = [userMsg, toolDone, finalAssistant]

function assistantTurn(turns: Turn[]): AssistantTurn {
  const turn = turns.find(t => t.type === 'assistant')
  if (!turn || turn.type !== 'assistant') throw new Error('expected an assistant turn')
  return turn
}

/**
 * The identity scheme this refactor replaced: message id when present, else a
 * position-dependent fallback. Reproduced locally to prove it changed identity
 * across the transition (which is exactly the bug).
 */
function legacyAssistantKey(turn: AssistantTurn, index: number): string {
  if (turn.response?.messageId) return `assistant:msg:${turn.response.messageId}`
  return `assistant:turn:${turn.turnId}:${turn.timestamp}:${index}`
}

describe('Turn identity across a mid-stream messageId arrival', () => {
  it('the scenario is real: response.messageId is absent, then present', () => {
    const before = assistantTurn(groupMessagesByTurn(beforeMessageId))
    const after = assistantTurn(groupMessagesByTurn(afterMessageId))
    expect(before.response?.messageId).toBeUndefined()
    expect(after.response?.messageId).toBe('assistant-final-1')
  })

  it('getTurnKey stays identical across the transition', () => {
    const before = assistantTurn(groupMessagesByTurn(beforeMessageId))
    const after = assistantTurn(groupMessagesByTurn(afterMessageId))
    expect(getTurnKey(before)).toBe(`turn-${TURN_ID}-1000`)
    expect(getTurnKey(after)).toBe(getTurnKey(before))
  })

  it('the legacy scheme would have changed identity (the bug being fixed)', () => {
    const before = assistantTurn(groupMessagesByTurn(beforeMessageId))
    const after = assistantTurn(groupMessagesByTurn(afterMessageId))
    expect(legacyAssistantKey(after, 0)).not.toBe(legacyAssistantKey(before, 0))
  })

  it('expansion keyed by getTurnKey survives the transition', () => {
    const before = assistantTurn(groupMessagesByTurn(beforeMessageId))
    // User expands the card while tools are still running.
    let state: ExpansionState = { expanded: new Set(), collapsed: new Set() }
    state = applyExpansionToggle(state, false, getTurnKey(before), true)
    expect(isIdExpanded(state, false, getTurnKey(before))).toBe(true)

    // The final response (with messageId) lands; regroup. Identity is unchanged,
    // so the same expansion state still resolves to expanded.
    const after = assistantTurn(groupMessagesByTurn(afterMessageId))
    expect(isIdExpanded(state, false, getTurnKey(after))).toBe(true)
  })

  it('the legacy key would have dropped that expansion', () => {
    const before = assistantTurn(groupMessagesByTurn(beforeMessageId))
    const after = assistantTurn(groupMessagesByTurn(afterMessageId))
    const expanded = new Set([legacyAssistantKey(before, 0)])
    expect(expanded.has(legacyAssistantKey(after, 0))).toBe(false)
  })
})

/**
 * Ported from the deleted assistant-ui-key.test.ts case "disambiguates split
 * cards with same turnId/timestamp via index fallback". Two assistant turns can
 * share BOTH turnId and timestamp — e.g. a tool turn interrupted by an `info`
 * message, immediately followed by a plan turn stamped identically. Without a
 * disambiguator both would collapse to `turn-<turnId>-<timestamp>` and share one
 * expansion entry (expanding one opens the other). getTurnKey now folds in a
 * grouping-time ordinal so the identities stay distinct — and stable across the
 * streaming re-renders that feed React reconciliation and scroll anchoring.
 */
describe('split cards with the same turnId + timestamp', () => {
  const TS = 1000
  const T = 'T'
  const splitMessages: Message[] = [
    { id: 'tool-a', role: 'tool', content: '', timestamp: TS, toolName: 'Read', toolUseId: 'tu-a', turnId: T },
    { id: 'info-1', role: 'info', content: 'Interrupted', timestamp: TS },
    { id: 'plan-1', role: 'plan', content: 'the plan', timestamp: TS, turnId: T },
  ]

  function assistantTurns(turns: Turn[]): AssistantTurn[] {
    return turns.filter((t): t is AssistantTurn => t.type === 'assistant')
  }

  it('produces two assistant turns sharing turnId and timestamp', () => {
    const assistants = assistantTurns(groupMessagesByTurn(splitMessages))
    expect(assistants.length).toBe(2)
    expect(assistants.map(t => t.turnId)).toEqual([T, T])
    expect(assistants.map(t => t.timestamp)).toEqual([TS, TS])
  })

  it('getTurnKey disambiguates them via the grouping-time ordinal', () => {
    const [a, b] = assistantTurns(groupMessagesByTurn(splitMessages))
    const keyA = getTurnKey(a)
    const keyB = getTurnKey(b)
    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe('turn-T-1000')
    expect(keyB).toBe('turn-T-1000-1')
  })

  it('the two cards no longer share one expansion entry', () => {
    const [a, b] = assistantTurns(groupMessagesByTurn(splitMessages))
    let state: ExpansionState = { expanded: new Set(), collapsed: new Set() }
    // Expand the first card; the second must stay collapsed.
    state = applyExpansionToggle(state, false, getTurnKey(a), true)
    expect(isIdExpanded(state, false, getTurnKey(a))).toBe(true)
    expect(isIdExpanded(state, false, getTurnKey(b))).toBe(false)
  })

  it('each identity stays stable as the split streams in (re-grouping is idempotent)', () => {
    // Before the plan lands: only the interrupted tool turn exists.
    const first = assistantTurns(groupMessagesByTurn(splitMessages.slice(0, 2)))
    expect(first.length).toBe(1)
    expect(getTurnKey(first[0]!)).toBe('turn-T-1000')

    // The plan lands; regroup. The first turn keeps its identity, the second
    // gets a distinct one — and grouping again yields the exact same keys.
    const full = assistantTurns(groupMessagesByTurn(splitMessages))
    const again = assistantTurns(groupMessagesByTurn(splitMessages))
    expect(getTurnKey(full[0]!)).toBe('turn-T-1000')
    expect(full.map(getTurnKey)).toEqual(again.map(getTurnKey))
  })
})
