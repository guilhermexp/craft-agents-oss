import { describe, expect, it } from 'bun:test'
import { SessionManager } from '../../sessions/SessionManager.ts'

describe('SessionManager.respondToUserQuestion', () => {
  it('returns false for an unknown session without throwing', () => {
    const sessionManager = new SessionManager()

    expect(sessionManager.respondToUserQuestion('missing-session', 'stale-request', {
      answers: {},
    })).toBe(false)
  })
})
