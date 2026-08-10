import { describe, expect, it } from 'bun:test'
import { processEvent } from '../processor'
import type { SessionState, ToolStartEvent, ToolResultEvent } from '../types'
import type { Session } from '../../../shared/types'

function emptyState(): SessionState {
  // Minimal fixture: processEvent's tool cases only read id + messages here.
  const session = {
    id: 'session-1',
    messages: [],
    lastMessageAt: Date.now(),
    isProcessing: true,
  } as unknown as Session
  return { session, streaming: null }
}

const askStart: ToolStartEvent = {
  type: 'tool_start',
  sessionId: 'session-1',
  toolUseId: 'q1',
  toolName: 'AskUserQuestion',
  toolInput: { questions: [] },
}

describe('processEvent AskUserQuestion effects', () => {
  it('emits question_pending on the first AskUserQuestion tool_start', () => {
    const { effects } = processEvent(emptyState(), askStart)
    expect(effects).toEqual([
      { type: 'question_pending', sessionId: 'session-1', toolUseId: 'q1' },
    ])
  })

  it('does not re-emit question_pending on the second (full-input) tool_start', () => {
    // First tool_start creates the tool message; the SDK then re-sends it with
    // the full input. The indicator/notification must fire only once.
    const first = processEvent(emptyState(), askStart)
    const second = processEvent(first.state, askStart)
    expect(second.effects).toEqual([])
  })

  it('emits question_resolved on tool_result even when the event omits toolName', () => {
    const parked = processEvent(emptyState(), askStart)
    const result: ToolResultEvent = {
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'q1',
      result: '{"questions":[],"answers":{}}',
    }
    const { effects } = processEvent(parked.state, result)
    expect(effects).toEqual([
      { type: 'question_resolved', sessionId: 'session-1', toolUseId: 'q1' },
    ])
  })

  it('emits no question effects for non-AskUserQuestion tools', () => {
    const start: ToolStartEvent = {
      type: 'tool_start',
      sessionId: 'session-1',
      toolUseId: 'b1',
      toolName: 'Bash',
      toolInput: {},
    }
    const started = processEvent(emptyState(), start)
    expect(started.effects).toEqual([])

    const result: ToolResultEvent = {
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'b1',
      result: 'ok',
    }
    const done = processEvent(started.state, result)
    expect(done.effects).toEqual([])
  })
})
