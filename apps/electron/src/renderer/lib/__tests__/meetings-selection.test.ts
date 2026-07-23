import { describe, expect, it } from 'bun:test'

import {
  isMissingMeetingError,
  normalizeGoogleMeetInput,
  resolveEffectiveMeetingId,
  shouldClearSelectedMeeting,
} from '../meetings-selection'

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

describe('normalizeGoogleMeetInput', () => {
  it('accepts meet codes and meet.google.com URLs', () => {
    expect(normalizeGoogleMeetInput('abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(normalizeGoogleMeetInput('abcdefghij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(normalizeGoogleMeetInput('https://meet.google.com/abc-defg-hij?authuser=1')).toBe('https://meet.google.com/abc-defg-hij')
  })
  it('rejects non-Meet URLs and junk', () => {
    expect(normalizeGoogleMeetInput('https://zoom.us/j/123')).toBeNull()
    expect(normalizeGoogleMeetInput('foo')).toBeNull()
    expect(normalizeGoogleMeetInput('https://evil.com/abc-defg-hij')).toBeNull()
  })
})
