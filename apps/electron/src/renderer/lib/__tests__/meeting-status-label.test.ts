import { describe, expect, it } from 'bun:test'
import type { MeetingRecord } from '../../../shared/types'
import { meetingStatusLabelKey } from '../meeting-status-label'

function makeRecord(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: 'meeting-1',
    provider: 'google-meet',
    captureMode: 'craft',
    status: 'stopped',
    url: 'https://meet.google.com/abc-defg-hij',
    browserInstanceId: 'browser-1',
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('meetingStatusLabelKey', () => {
  it('reports an unsealed recording as interrupted', () => {
    const record = makeRecord({
      status: 'stopped',
      recording: { path: '/tmp/a.webm', partial: true },
    })
    expect(meetingStatusLabelKey(record)).toBe('meetings.statusInterrupted')
  })

  it('reports a sealed recording as stopped', () => {
    expect(meetingStatusLabelKey(makeRecord({
      status: 'stopped',
      recording: { path: '/tmp/a.webm', bytesWritten: 10, durationMs: 1000 },
    }))).toBe('meetings.statusStopped')
    // Sem gravação nenhuma (captura Hermes) também é apenas "finalizada".
    expect(meetingStatusLabelKey(makeRecord({ status: 'stopped' }))).toBe('meetings.statusStopped')
  })

  it('keeps live and error statuses untouched, even while partial', () => {
    // Enquanto roda, `partial` é o estado normal — não é interrupção.
    expect(meetingStatusLabelKey(makeRecord({
      status: 'running',
      recording: { path: '/tmp/a.webm', partial: true },
    }))).toBe('meetings.statusRunning')
    expect(meetingStatusLabelKey(makeRecord({ status: 'starting' }))).toBe('meetings.statusStarting')
    expect(meetingStatusLabelKey(makeRecord({
      status: 'error',
      recording: { path: '/tmp/a.webm', partial: true },
    }))).toBe('meetings.statusError')
  })
})
