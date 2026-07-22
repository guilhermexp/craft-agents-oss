/**
 * Tests for reconcileTurns — the structural-sharing pass that keeps React.memo
 * on TurnCard effective during streaming.
 *
 * The contract: reuse the previous Turn object (by reference) whenever a turn's
 * value is unchanged, so completed turns skip re-rendering on every streaming
 * token; always take the fresh object for streaming/incomplete turns and for
 * turns whose content actually changed.
 */

import { describe, it, expect } from 'bun:test'
import { reconcileTurns, type Turn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

function keyOf(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  if (turn.type === 'auth-request') return `auth-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

function assistant(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'turn-1',
    activities: [],
    response: { text: 'done', isStreaming: false, messageId: 'msg-1' },
    intent: undefined,
    isStreaming: false,
    isComplete: true,
    timestamp: 100,
    ...overrides,
  }
}

function userMessage(id: string): Message {
  return { id, role: 'user', content: 'hi', timestamp: 1 }
}

describe('reconcileTurns', () => {
  it('returns the fresh list on the first pass (no previous turns)', () => {
    const next = [assistant()]
    expect(reconcileTurns([], next, keyOf)).toBe(next)
  })

  it('reuses a completed turn object when its value is unchanged', () => {
    const prev = [assistant()]
    const next = [assistant()] // fresh object, identical values
    const result = reconcileTurns(prev, next, keyOf)
    expect(result[0]).toBe(prev[0])
  })

  it('always takes the fresh object for a streaming turn', () => {
    const streaming = { isStreaming: true, isComplete: false } as const
    const prev = [assistant({ ...streaming, response: { text: 'par', isStreaming: true, messageId: 'msg-1' } })]
    const next = [assistant({ ...streaming, response: { text: 'partial', isStreaming: true, messageId: 'msg-1' } })]
    const result = reconcileTurns(prev, next, keyOf)
    expect(result[0]).toBe(next[0])
    expect(result[0]).not.toBe(prev[0])
  })

  it('reuses completed turns while appending a newly streamed turn', () => {
    const prev = [assistant()]
    const completed = assistant()
    const streaming = assistant({ turnId: 'turn-2', timestamp: 200, isStreaming: true, isComplete: false })
    const result = reconcileTurns(prev, [completed, streaming], keyOf)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(prev[0]) // completed turn reused across the token
    expect(result[1]).toBe(streaming) // new streaming turn fresh
  })

  it('refreshes a completed turn when its response text changed', () => {
    const prev = [assistant({ response: { text: 'hi', isStreaming: false, messageId: 'msg-1' } })]
    const next = [assistant({ response: { text: 'hi there', isStreaming: false, messageId: 'msg-1' } })]
    const result = reconcileTurns(prev, next, keyOf)
    expect(result[0]).toBe(next[0])
  })

  it('refreshes a completed turn when an activity field changed', () => {
    const base = { id: 'a1', type: 'tool', status: 'completed', timestamp: 1 } as const
    const prev = [assistant({ activities: [{ ...base }] })]
    const next = [assistant({ activities: [{ ...base, status: 'error', error: 'boom' }] })]
    const result = reconcileTurns(prev, next, keyOf)
    expect(result[0]).toBe(next[0])
  })

  it('reuses a user turn when its message reference is identical', () => {
    const message = userMessage('u1')
    const prev: Turn[] = [{ type: 'user', message, timestamp: 1 }]
    const next: Turn[] = [{ type: 'user', message, timestamp: 1 }]
    expect(reconcileTurns(prev, next, keyOf)[0]).toBe(prev[0])
  })

  it('refreshes a user turn when its message reference changed', () => {
    const prev: Turn[] = [{ type: 'user', message: userMessage('u1'), timestamp: 1 }]
    const next: Turn[] = [{ type: 'user', message: userMessage('u1'), timestamp: 1 }]
    expect(reconcileTurns(prev, next, keyOf)[0]).toBe(next[0])
  })

  it('returns the previous array reference when every turn is unchanged', () => {
    const message = userMessage('u1')
    const prev: Turn[] = [{ type: 'user', message, timestamp: 1 }, assistant()]
    const next: Turn[] = [{ type: 'user', message, timestamp: 1 }, assistant()]
    expect(reconcileTurns(prev, next, keyOf)).toBe(prev)
  })

  it('produces a new array when a turn is appended', () => {
    const prev = [assistant()]
    const next = [assistant(), assistant({ turnId: 'turn-2', timestamp: 200 })]
    const result = reconcileTurns(prev, next, keyOf)
    expect(result).not.toBe(prev)
    expect(result).toHaveLength(2)
  })
})
