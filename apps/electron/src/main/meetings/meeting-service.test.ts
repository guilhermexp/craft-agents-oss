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

    expect(service.status(workspaceRoot, record.id)?.recording?.path).toBe(recordingPath)
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(true)
    expect(existsSync(recordingPath)).toBe(true)

    service.deleteMeeting(workspaceRoot, record.id)

    expect(service.list(workspaceRoot, { includeArchived: true })).toEqual([])
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(false)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(false)
    expect(existsSync(recordingPath)).toBe(false)
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

  it('runs post-meeting summary generation when only follow-up is enabled', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-follow-up-'))
    tempDirs.push(workspaceRoot)

    credentials.set(JSON.stringify({
      type: 'meeting_transcription_api_key',
      workspaceId: 'ws-test',
      name: 'deepgram',
    }), { value: 'dg-test-key' })

    const service = new MeetingService(createBrowserPaneManager())
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
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(summaryRequests).toHaveLength(1)
    expect(summaryRequests[0]?.systemPrompt).toContain('follow-up')
    expect(service.status(workspaceRoot, record.id)?.summaryMarkdown).toContain('## Follow-up')
  })
})
