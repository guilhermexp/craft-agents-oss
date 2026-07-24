import { describe, expect, it } from 'bun:test'
import {
  decideOverflowSuppression,
  isContextOverflowErrorMessage,
  isAlreadyCompactedMessage,
} from './overflow-recovery.ts'

describe('isContextOverflowErrorMessage', () => {
  it('matches the Codex context-window error from the field report', () => {
    expect(
      isContextOverflowErrorMessage(
        'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.',
      ),
    ).toBe(true)
  })

  it('matches known overflow signatures case-insensitively', () => {
    expect(isContextOverflowErrorMessage('context_length_exceeded')).toBe(true)
    expect(isContextOverflowErrorMessage('CONTEXT_LENGTH_EXCEEDED')).toBe(true)
    expect(isContextOverflowErrorMessage('Too many tokens in request')).toBe(true)
    expect(isContextOverflowErrorMessage('token limit exceeded')).toBe(true)
    expect(isContextOverflowErrorMessage('the context window was exceeded')).toBe(true)
  })

  it('does not match unrelated provider errors', () => {
    expect(isContextOverflowErrorMessage('Bad Request')).toBe(false)
    expect(isContextOverflowErrorMessage('401 Unauthorized')).toBe(false)
    expect(isContextOverflowErrorMessage('Already compacted')).toBe(false)
  })
})

describe('isAlreadyCompactedMessage', () => {
  it('matches the SDK "already compacted" / "nothing to compact" races case-insensitively', () => {
    expect(isAlreadyCompactedMessage('Already compacted')).toBe(true)
    expect(isAlreadyCompactedMessage('already compacted')).toBe(true)
    expect(isAlreadyCompactedMessage('Nothing to compact')).toBe(true)
    expect(isAlreadyCompactedMessage('Compaction failed: Already compacted')).toBe(true)
  })

  it('does not match real compaction failures or unrelated errors', () => {
    expect(isAlreadyCompactedMessage('Compaction failed: Out of memory')).toBe(false)
    expect(isAlreadyCompactedMessage('context_length_exceeded')).toBe(false)
    expect(isAlreadyCompactedMessage('Bad Request')).toBe(false)
  })
})

describe('decideOverflowSuppression', () => {
  const idle = { inProgress: false, retryPhase: false }
  const compactPhase = { inProgress: true, retryPhase: false }
  const retryPhase = { inProgress: true, retryPhase: true }

  const compactionError = {
    type: 'compaction_end',
    errorMessage: 'Compaction failed: Already compacted',
    result: undefined,
  }
  const assistantError = {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error' },
  }

  it('forwards everything when no recovery is in flight', () => {
    expect(decideOverflowSuppression(compactionError, idle)).toEqual({ action: 'forward' })
    expect(decideOverflowSuppression(assistantError, idle)).toEqual({ action: 'forward' })
  })

  it('suppresses a compaction failure during recovery but only terminalizes in the retry phase', () => {
    // During the manual-compact phase the "already compacted" race is handled
    // by the caller's try/catch, so drop the event without ending the turn.
    expect(decideOverflowSuppression(compactionError, compactPhase)).toEqual({
      action: 'suppress',
      terminal: false,
    })
    // A compaction failure while retrying means recovery is exhausted.
    expect(decideOverflowSuppression(compactionError, retryPhase)).toEqual({
      action: 'suppress',
      terminal: true,
    })
  })

  it('suppresses the raw provider error on a re-overflowing retry without ending the turn', () => {
    // The SDK's own auto-compaction may still recover on this turn, so dropping
    // the raw error must not itself declare recovery exhausted.
    expect(decideOverflowSuppression(assistantError, retryPhase)).toEqual({
      action: 'suppress',
      terminal: false,
    })
  })

  it('does not suppress the raw provider error during the compact phase', () => {
    expect(decideOverflowSuppression(assistantError, compactPhase)).toEqual({ action: 'forward' })
  })

  it('forwards a successful compaction so the "Compacted" status still shows', () => {
    const success = {
      type: 'compaction_end',
      result: { summary: 'ok' },
    }
    expect(decideOverflowSuppression(success, retryPhase)).toEqual({ action: 'forward' })
  })

  it('forwards an aborted compaction (no error, no result)', () => {
    const aborted = { type: 'compaction_end', aborted: true }
    expect(decideOverflowSuppression(aborted, retryPhase)).toEqual({ action: 'forward' })
  })

  it('forwards the successful retry answer and its agent_end', () => {
    const answer = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }
    const agentEnd = { type: 'agent_end' }
    expect(decideOverflowSuppression(answer, retryPhase)).toEqual({ action: 'forward' })
    expect(decideOverflowSuppression(agentEnd, retryPhase)).toEqual({ action: 'forward' })
  })

  it('ignores non-assistant message_end errors (user / tool echoes)', () => {
    const userError = { type: 'message_end', message: { role: 'user', stopReason: 'error' } }
    expect(decideOverflowSuppression(userError, retryPhase)).toEqual({ action: 'forward' })
  })
})
