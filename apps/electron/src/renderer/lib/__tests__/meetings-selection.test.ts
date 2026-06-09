import { describe, expect, it } from 'bun:test'

import { isMissingMeetingError, resolveEffectiveMeetingId, shouldClearSelectedMeeting } from '../meetings-selection'

describe('meetings selection helpers', () => {
  it('clears a selected meeting when the refreshed list no longer contains it', () => {
    expect(shouldClearSelectedMeeting([{ id: 'kept' }], 'deleted')).toBe(true)
    expect(shouldClearSelectedMeeting([{ id: 'kept' }], 'kept')).toBe(false)
    expect(shouldClearSelectedMeeting([], null)).toBe(false)
  })

  it('treats missing meeting errors as stale selection errors', () => {
    expect(isMissingMeetingError(new Error('Meeting not found: abc'))).toBe(true)
    expect(isMissingMeetingError('Meeting not found: abc')).toBe(true)
    expect(isMissingMeetingError(new Error('Network unavailable'))).toBe(false)
  })

  it('ignores an effective meeting id already known to be missing', () => {
    expect(resolveEffectiveMeetingId({
      selectedMeetingId: 'deleted',
      liveStartedId: null,
      missingMeetingId: 'deleted',
    })).toBeNull()
    expect(resolveEffectiveMeetingId({
      selectedMeetingId: null,
      liveStartedId: 'live',
      missingMeetingId: 'deleted',
    })).toBe('live')
  })
})
