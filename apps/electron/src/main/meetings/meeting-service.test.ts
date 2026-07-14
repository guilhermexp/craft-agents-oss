import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserPaneManager } from '../browser-pane-manager'
import type { MeetingRecord, MeetingTranscriptSegment } from '../../shared/types'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'
import type { LLMQueryRequest, LLMQueryResult } from '@craft-agent/shared/agent/llm-tool'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'

const tempDirs: string[] = []
const metadataDirs: string[] = []
const credentials = new Map<string, { value: string }>()
const summaryRequests: LLMQueryRequest[] = []
type VideoAnalysisInput = {
  workspaceId: string
  workspaceRootPath: string
  recordingPath: string
  outputDir: string
  segments: MeetingTranscriptSegment[]
  record: MeetingRecord
}
const videoAnalysisRequests: VideoAnalysisInput[] = []

mock.module('electron', () => ({
  session: {
    fromPartition: mock(() => ({
      cookies: {
        get: mock(async () => []),
      },
    })),
  },
}))

mock.module('../handlers/hermes-runtime', () => ({
  getHermesRuntimePaths: () => null,
}))

mock.module('../browser-profile-resolver', () => ({
  getProfilePartition: () => 'persist:default',
}))

mock.module('../logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { mainLog: logger }
})

mock.module('@craft-agent/shared/credentials', () => ({
  getCredentialManager: () => ({
    get: async (id: unknown) => credentials.get(JSON.stringify(id)) ?? null,
    set: async (id: unknown, value: { value: string }) => { credentials.set(JSON.stringify(id), value) },
    delete: async (id: unknown) => { credentials.delete(JSON.stringify(id)) },
  }),
}))

mock.module('@craft-agent/shared/config', () => ({
  getDefaultLlmConnection: () => 'claude-default',
  getLlmConnection: (slug: string) => ({ slug, providerType: 'anthropic' }),
  getLlmConnections: () => [{ slug: 'claude-default', providerType: 'anthropic' }],
}))

mock.module('@craft-agent/shared/skills', () => ({
  loadSkill: () => null,
}))

mock.module('@craft-agent/shared/agent/backend', () => ({
  createBackendFromConnection: () => ({
    async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
      summaryRequests.push(request)
      return { text: '## Follow-up\n\n- Guilherme: ship the follow-up fix tomorrow.' }
    },
    destroy: () => {},
  } as Pick<AgentBackend, 'queryLlm' | 'destroy'>),
}))

mock.module('./transcription-service', () => ({
  TranscriptionService: class {
    async transcribe(): Promise<{ segments: MeetingTranscriptSegment[]; text: string }> {
      return {
        segments: [
          {
            id: 'segment-1',
            speaker: 'Speaker 1',
            text: 'Guilherme will ship the follow-up fix tomorrow.',
            timestamp: 0,
          },
        ],
        text: 'Guilherme will ship the follow-up fix tomorrow.',
      }
    }
  },
}))

mock.module('./meeting-video-analysis-service', () => ({
  generateMeetingVideoAnalysisMarkdown: async (input: VideoAnalysisInput): Promise<string> => {
    videoAnalysisRequests.push(input)
    return '## Visual analysis\n\n- The recording was reviewed with visual evidence.'
  },
}))

mock.module('./meeting-video-analysis-service.ts', () => ({
  generateMeetingVideoAnalysisMarkdown: async (input: VideoAnalysisInput): Promise<string> => {
    videoAnalysisRequests.push(input)
    return '## Visual analysis\n\n- The recording was reviewed with visual evidence.'
  },
}))

const { MeetingService } = await import('./meeting-service')

function createBrowserPaneManager(): BrowserPaneManager {
  const instances = new Map<string, { id: string }>()
  let nextId = 0
  return {
    createInstance: mock((_id?: string, _options?: unknown) => {
      const id = `browser-${++nextId}`
      instances.set(id, { id })
      return id
    }),
    getInstance: mock((id: string) => instances.get(id)),
    navigate: mock(async () => ({ url: 'https://meet.google.com/abc-defg-hij', title: 'Meet' })),
    focus: mock(() => {}),
    destroyInstance: mock((id: string) => { instances.delete(id) }),
  } as unknown as BrowserPaneManager
}

beforeEach(() => {
  credentials.clear()
  summaryRequests.splice(0)
  videoAnalysisRequests.splice(0)
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of metadataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('MeetingService storage', () => {
  it('persists meeting records, transcripts, and summaries under workspace meetings storage', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
      title: 'Storage Test',
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    expect(existsSync(join(meetingsDir, 'meetings.json'))).toBe(true)
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'meetings.json.tmp'))).toBe(false)

    const reloaded = new MeetingService(createBrowserPaneManager())
    expect(reloaded.list(workspaceRoot).map(item => item.id)).toEqual([record.id])
  })

  it('clears stale summary markdown from storage and transcript when summaryMarkdown is cleared', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-summary-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const summaryPath = join(meetingsDir, 'summaries', `${record.id}.md`)
    expect(existsSync(summaryPath)).toBe(true)

    const privateService = service as unknown as {
      getWorkspaceState(root: string): unknown
      updateRecord(state: unknown, id: string, updates: { summaryMarkdown?: string | null }): void
    }
    const state = privateService.getWorkspaceState(workspaceRoot)
    privateService.updateRecord(state, record.id, { summaryMarkdown: null })

    expect(existsSync(summaryPath)).toBe(false)
    const transcriptPath = join(meetingsDir, 'transcripts', `${record.id}.json`)
    const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { summaryMarkdown?: string }
    expect('summaryMarkdown' in transcript).toBe(false)
  })

  it('rejects unsupported transcription providers instead of silently defaulting', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-provider-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())

    await expect(service.saveTranscriptionConfig('ws-test', workspaceRoot, {
      provider: 'bogus' as never,
      model: 'model',
    })).rejects.toThrow('Unsupported transcription provider')

    await expect(service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      transcriptionProvider: 'bogus' as never,
    })).rejects.toThrow('Unsupported transcription provider')

    await expect(service.saveTranscriptionConfig('ws-test', workspaceRoot, {
      provider: 'groq' as never,
      model: 'whisper-large-v3',
    })).rejects.toThrow('Unsupported transcription provider')

    await expect(service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      transcriptionProvider: 'groq' as never,
    })).rejects.toThrow('Unsupported transcription provider')
  })

  it('archives records out of the default list and can unarchive them', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-archive-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    service.archive(workspaceRoot, record.id)

    expect(service.list(workspaceRoot).map(item => item.id)).toEqual([])
    expect(service.list(workspaceRoot, { includeArchived: true }).map(item => item.id)).toEqual([record.id])

    service.unarchive(workspaceRoot, record.id)

    expect(service.list(workspaceRoot).map(item => item.id)).toEqual([record.id])
  })

  it('persists recording metadata and deleteMeeting removes record artifacts', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-delete-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingPath = join(meetingsDir, 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'audio')

    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 5,
      durationMs: 1000,
      mimeType: 'audio/webm',
    })

    // Simulate generated visual-analysis evidence on disk for this meeting.
    const videoAnalysisDir = join(meetingsDir, 'video-analysis', record.id)
    mkdirSync(videoAnalysisDir, { recursive: true })
    writeFileSync(join(videoAnalysisDir, 'frame-0000s.jpg'), 'frame')

    expect(service.status(workspaceRoot, record.id)?.recording?.path).toBe(recordingPath)
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(true)
    expect(existsSync(recordingPath)).toBe(true)
    expect(existsSync(videoAnalysisDir)).toBe(true)

    service.deleteMeeting(workspaceRoot, record.id)

    expect(service.list(workspaceRoot, { includeArchived: true })).toEqual([])
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(false)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(false)
    expect(existsSync(recordingPath)).toBe(false)
    expect(existsSync(videoAnalysisDir)).toBe(false)
  })

  it('reconciles orphan .webm recordings on first ensureLoaded and keeps referenced files', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-orphans-'))
    tempDirs.push(workspaceRoot)

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingsDir = join(meetingsDir, 'recordings')

    const keptPath = join(recordingsDir, '22222222-2222-2222-2222-222222222222.webm')
    const orphanPath = join(recordingsDir, '11111111-1111-1111-1111-111111111111.webm')
    const stagingPath = join(recordingsDir, '.33333333-3333-3333-3333-333333333333.tmp')

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })
    // Mark `keptPath` as referenced by the meeting record so it survives the
    // orphan sweep, then simulate the recording artifacts left over from a
    // previous app session (one good, one orphan, one atomic-write staging).
    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: keptPath,
      bytesWritten: 19,
      durationMs: 1000,
      mimeType: 'audio/webm',
    })
    mkdirSync(recordingsDir, { recursive: true })
    writeFileSync(keptPath, 'kept-partial-bytes')
    writeFileSync(orphanPath, 'orphan-partial-bytes')
    writeFileSync(stagingPath, 'atomic-write-staging')

    // Pre-conditions: both webm files + the atomic staging file exist.
    expect(existsSync(orphanPath)).toBe(true)
    expect(existsSync(keptPath)).toBe(true)
    expect(existsSync(stagingPath)).toBe(true)

    // Trigger ensureLoaded on a fresh service instance (simulates app restart).
    const reloaded = new MeetingService(createBrowserPaneManager())
    reloaded.list(workspaceRoot)

    // Orphan .webm was deleted, referenced .webm was kept, .tmp staging untouched.
    expect(existsSync(orphanPath)).toBe(false)
    expect(existsSync(keptPath)).toBe(true)
    expect(existsSync(stagingPath)).toBe(true)
  })

  it('does not delete orphan recordings that belong to a different workspace', async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), 'craft-meetings-orphans-a-'))
    const workspaceB = mkdtempSync(join(tmpdir(), 'craft-meetings-orphans-b-'))
    tempDirs.push(workspaceA, workspaceB)

    const meetingsDirA = getWorkspaceMeetingsPath(workspaceA)
    const meetingsDirB = getWorkspaceMeetingsPath(workspaceB)
    metadataDirs.push(dirname(meetingsDirA), dirname(meetingsDirB))
    const recordingsA = join(meetingsDirA, 'recordings')
    const recordingsB = join(meetingsDirB, 'recordings')
    mkdirSync(recordingsA, { recursive: true })
    mkdirSync(recordingsB, { recursive: true })

    const service = new MeetingService(createBrowserPaneManager())
    // Create one record per workspace so each ensureLoaded runs the reconcile
    // pass and the records are not held in the same in-memory state.
    await service.start(workspaceA, { urlOrCode: 'abc-defg-hij', captureMode: 'craft', transcribe: false })
    await service.start(workspaceB, { urlOrCode: 'abc-defg-hij', captureMode: 'craft', transcribe: false })

    const orphanA = join(recordingsA, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webm')
    const orphanB = join(recordingsB, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webm')
    writeFileSync(orphanA, 'orphan-a')
    writeFileSync(orphanB, 'orphan-b')

    // New service instance triggers fresh ensureLoaded for both workspaces.
    const reloaded = new MeetingService(createBrowserPaneManager())
    reloaded.list(workspaceA)
    reloaded.list(workspaceB)

    expect(existsSync(orphanA)).toBe(false)
    expect(existsSync(orphanB)).toBe(false)
  })

  it('runs visual video analysis for every completed recording even when transcription is disabled', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-video-analysis-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager(), undefined, async (input) => {
      videoAnalysisRequests.push(input)
      return '## Visual analysis\n\n- The recording was reviewed with visual evidence.'
    })
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
      summarizeOnEnd: false,
      followUpOnEnd: false,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingPath = join(meetingsDir, 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'video')

    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 5,
      durationMs: 1000,
      mimeType: 'video/webm',
    })
    for (let i = 0; i < 20 && videoAnalysisRequests.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(videoAnalysisRequests).toHaveLength(1)
    expect(videoAnalysisRequests[0]?.recordingPath).toBe(recordingPath)
    expect(videoAnalysisRequests[0]?.segments).toEqual([])
    // Pin the evidence-dir contract that deleteMeeting's rmSync depends on.
    expect(videoAnalysisRequests[0]?.workspaceId).toBe('ws-test')
    expect(videoAnalysisRequests[0]?.workspaceRootPath).toBe(workspaceRoot)
    expect(videoAnalysisRequests[0]?.outputDir).toBe(join(meetingsDir, 'video-analysis', record.id))
    expect(service.status(workspaceRoot, record.id)?.summaryMarkdown).toContain('## Visual analysis')
  })

  it('passes the ready transcript and follow-up flag into visual post-meeting analysis', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-follow-up-'))
    tempDirs.push(workspaceRoot)

    credentials.set(JSON.stringify({
      type: 'meeting_transcription_api_key',
      workspaceId: 'ws-test',
      name: 'deepgram',
    }), { value: 'dg-test-key' })

    const service = new MeetingService(createBrowserPaneManager(), undefined, async (input) => {
      videoAnalysisRequests.push(input)
      return '## Follow-up\n\n- Guilherme: ship the follow-up fix tomorrow.'
    })
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: true,
      summarizeOnEnd: false,
      followUpOnEnd: true,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingPath = join(meetingsDir, 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'audio')

    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 5,
      durationMs: 1000,
      mimeType: 'audio/webm',
    })
    for (let i = 0; i < 20 && videoAnalysisRequests.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(videoAnalysisRequests).toHaveLength(1)
    expect(videoAnalysisRequests[0]?.record.followUpOnEnd).toBe(true)
    expect(videoAnalysisRequests[0]?.segments.map(segment => segment.text)).toEqual([
      'Guilherme will ship the follow-up fix tomorrow.',
    ])
    expect(service.status(workspaceRoot, record.id)?.summaryMarkdown).toContain('## Follow-up')
  })

  it('falls back to the text-only agent summary when visual analysis returns null', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-fallback-'))
    tempDirs.push(workspaceRoot)

    credentials.set(JSON.stringify({
      type: 'meeting_transcription_api_key',
      workspaceId: 'ws-test',
      name: 'deepgram',
    }), { value: 'dg-test-key' })

    // Generator returns null (e.g. no evidence / tools missing with a transcript),
    // which must hand off to the legacy text-only summary path.
    const service = new MeetingService(createBrowserPaneManager(), undefined, async () => null)
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: true,
      summarizeOnEnd: false,
      followUpOnEnd: true,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingPath = join(meetingsDir, 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'audio')

    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 5,
      durationMs: 1000,
      mimeType: 'audio/webm',
    })
    for (let i = 0; i < 30 && summaryRequests.length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(summaryRequests).toHaveLength(1)
    expect(service.status(workspaceRoot, record.id)?.summaryMarkdown).toContain('## Follow-up')
  })

  it('does not fall back to a text summary when visual analysis returns null without a transcript', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-no-fallback-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager(), undefined, async () => null)
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
      summarizeOnEnd: false,
      followUpOnEnd: true,
    })

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const recordingPath = join(meetingsDir, 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'video')

    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 5,
      durationMs: 1000,
      mimeType: 'video/webm',
    })
    // Give the fire-and-forget analysis time to run and (not) fall back.
    await new Promise(resolve => setTimeout(resolve, 60))

    // No transcript segments means there is nothing for the text-only summary
    // path to work with, so it must not run.
    expect(summaryRequests).toHaveLength(0)
  })

  // Simulate the on-disk state left by a crash/quit mid-transcription: the
  // meeting record has the recording metadata and the persisted transcript is
  // still 'capturing' (completeRecording persists that status before the
  // fire-and-forget transcribeRecording finishes).
  function writeInterruptedTranscriptionFixture(workspaceRoot: string, options: { audioOnDisk: boolean }): { meetingId: string; meetingsDir: string } {
    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))
    const meetingId = '44444444-4444-4444-4444-444444444444'
    const recordingPath = join(meetingsDir, 'recordings', `${meetingId}.webm`)
    if (options.audioOnDisk) {
      mkdirSync(dirname(recordingPath), { recursive: true })
      writeFileSync(recordingPath, 'audio')
    }
    mkdirSync(meetingsDir, { recursive: true })
    writeFileSync(join(meetingsDir, 'meetings.json'), JSON.stringify({
      version: 1,
      meetings: [{
        id: meetingId,
        provider: 'google-meet',
        captureMode: 'craft',
        status: 'stopped',
        url: 'https://meet.google.com/abc-defg-hij',
        browserInstanceId: 'browser-1',
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
        endedAt: Date.now() - 5_000,
        transcriptionProvider: 'deepgram',
        transcriptionModel: 'nova-3',
        recording: { path: recordingPath, mimeType: 'audio/webm', bytesWritten: 5, durationMs: 1000 },
      }],
    }))
    mkdirSync(join(meetingsDir, 'transcripts'), { recursive: true })
    writeFileSync(join(meetingsDir, 'transcripts', `${meetingId}.json`), JSON.stringify({
      meetingId,
      status: 'capturing',
      transcript: [],
      message: 'Transcrevendo o audio gravado com Deepgram.',
      updatedAt: Date.now() - 5_000,
    }))
    return { meetingId, meetingsDir }
  }

  it('recovers an interrupted capturing transcript by re-dispatching transcription when the audio exists', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-recovery-'))
    tempDirs.push(workspaceRoot)
    const { meetingId } = writeInterruptedTranscriptionFixture(workspaceRoot, { audioOnDisk: true })

    credentials.set(JSON.stringify({
      type: 'meeting_transcription_api_key',
      workspaceId: 'ws-test',
      name: 'deepgram',
    }), { value: 'dg-test-key' })

    const service = new MeetingService(createBrowserPaneManager())
    await service.recoverInterruptedTranscriptions('ws-test', workspaceRoot)

    let transcript = service.transcript(workspaceRoot, meetingId)
    for (let i = 0; i < 50 && transcript.status === 'capturing'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      transcript = service.transcript(workspaceRoot, meetingId)
    }

    expect(transcript.status).toBe('ready')
    expect(transcript.transcript.map(segment => segment.text)).toEqual([
      'Guilherme will ship the follow-up fix tomorrow.',
    ])
  })

  it('demotes an interrupted capturing transcript to unavailable when the audio is gone', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-recovery-gone-'))
    tempDirs.push(workspaceRoot)
    const { meetingId, meetingsDir } = writeInterruptedTranscriptionFixture(workspaceRoot, { audioOnDisk: false })

    const service = new MeetingService(createBrowserPaneManager())
    await service.recoverInterruptedTranscriptions('ws-test', workspaceRoot)

    const transcript = service.transcript(workspaceRoot, meetingId)
    expect(transcript.status).toBe('unavailable')
    expect(transcript.message).toContain('interrompida')
    // The demotion must be persisted so a later reload does not resurrect 'capturing'.
    const persisted = JSON.parse(readFileSync(join(meetingsDir, 'transcripts', `${meetingId}.json`), 'utf8')) as { status: string }
    expect(persisted.status).toBe('unavailable')
  })

  it('demotes an interrupted capturing transcript to unavailable when the API key is missing', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-recovery-nokey-'))
    tempDirs.push(workspaceRoot)
    const { meetingId } = writeInterruptedTranscriptionFixture(workspaceRoot, { audioOnDisk: true })

    const service = new MeetingService(createBrowserPaneManager())
    await service.recoverInterruptedTranscriptions('ws-test', workspaceRoot)

    let transcript = service.transcript(workspaceRoot, meetingId)
    for (let i = 0; i < 50 && transcript.status === 'capturing'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      transcript = service.transcript(workspaceRoot, meetingId)
    }

    expect(transcript.status).toBe('unavailable')
    expect(transcript.message).toBe('Transcription API key not configured.')
  })

  it('reconciles orphan video-analysis dirs on ensureLoaded and keeps owned ones', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-va-orphans-'))
    tempDirs.push(workspaceRoot)

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    metadataDirs.push(dirname(meetingsDir))

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const videoAnalysisRoot = join(meetingsDir, 'video-analysis')
    const ownedDir = join(videoAnalysisRoot, record.id)
    const orphanDir = join(videoAnalysisRoot, '99999999-9999-9999-9999-999999999999')
    mkdirSync(ownedDir, { recursive: true })
    mkdirSync(orphanDir, { recursive: true })
    writeFileSync(join(ownedDir, 'frame.jpg'), 'owned')
    writeFileSync(join(orphanDir, 'frame.jpg'), 'orphan')

    expect(existsSync(ownedDir)).toBe(true)
    expect(existsSync(orphanDir)).toBe(true)

    // Fresh instance triggers ensureLoaded -> reconcile on first access.
    const reloaded = new MeetingService(createBrowserPaneManager())
    reloaded.list(workspaceRoot)

    expect(existsSync(orphanDir)).toBe(false)
    expect(existsSync(ownedDir)).toBe(true)
  })
})
