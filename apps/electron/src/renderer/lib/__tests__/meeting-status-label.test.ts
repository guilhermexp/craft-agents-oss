import { describe, expect, it } from 'bun:test'
import type { MeetingRecord } from '../../../shared/types'
import { isMeetingPostProcessingRunning, meetingStatusLabelKey } from '../meeting-status-label'

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

describe('post-processing phase in the status label', () => {
  it('shows the running phase instead of presenting the meeting as finished', () => {
    expect(meetingStatusLabelKey(makeRecord({ postProcessingPhase: 'preparing' })))
      .toBe('meetings.statusProcessingPreparing')
    expect(meetingStatusLabelKey(makeRecord({ postProcessingPhase: 'transcribing' })))
      .toBe('meetings.statusProcessingTranscribing')
    expect(meetingStatusLabelKey(makeRecord({ postProcessingPhase: 'analyzing' })))
      .toBe('meetings.statusProcessingAnalyzing')
  })

  it('gives the failed pipeline its own state', () => {
    expect(meetingStatusLabelKey(makeRecord({ postProcessingPhase: 'failed' })))
      .toBe('meetings.statusProcessingFailed')
  })

  it('falls back to the terminal status once the pipeline resolves', () => {
    expect(meetingStatusLabelKey(makeRecord({ postProcessingPhase: 'completed' })))
      .toBe('meetings.statusStopped')
  })

  it('keeps an unsealed capture reported as interrupted', () => {
    // Um parcial nunca chegou ao pipeline: a captura é a informação relevante.
    expect(meetingStatusLabelKey(makeRecord({
      postProcessingPhase: 'failed',
      recording: { path: '/tmp/a.webm', partial: true },
    }))).toBe('meetings.statusInterrupted')
  })

  it('reports the pipeline as running only until it resolves', () => {
    for (const phase of ['preparing', 'transcribing', 'analyzing'] as const) {
      expect(isMeetingPostProcessingRunning(makeRecord({ postProcessingPhase: phase }))).toBe(true)
    }
    expect(isMeetingPostProcessingRunning(makeRecord({ postProcessingPhase: 'completed' }))).toBe(false)
    expect(isMeetingPostProcessingRunning(makeRecord({ postProcessingPhase: 'failed' }))).toBe(false)
    // Captura Hermes e reuniões antigas não têm fase nenhuma.
    expect(isMeetingPostProcessingRunning(makeRecord({}))).toBe(false)
  })
})
