import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { BrowserPaneManager } from '../browser-pane-manager'
import type { MeetingRecord, MeetingTranscriptSegment } from '../../shared/types'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'
import type { LLMQueryRequest, LLMQueryResult } from '@craft-agent/shared/agent/llm-tool'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import * as realCredentials from '@craft-agent/shared/credentials'
import { createLoggerModuleStub } from '../__tests__/logger-module-stub'

/**
 * Meetings storage resolves the config root on every call, so the whole suite
 * writes workspace metadata into one tmpdir instead of the user's real
 * `~/.craft-agent`. Set before the service module loads and torn down as a
 * single directory; per-test metadata bookkeeping is no longer needed.
 */
const configRoot = mkdtempSync(join(tmpdir(), 'craft-config-meetings-'))
process.env.CRAFT_CONFIG_DIR = configRoot

const realWorkspacesDir = join(homedir(), '.craft-agent', 'workspaces')

function listRealWorkspaces(): string[] {
  try {
    return readdirSync(realWorkspacesDir).sort()
  } catch {
    return []
  }
}

let realWorkspacesBefore: string[] = []

beforeAll(() => {
  realWorkspacesBefore = listRealWorkspaces()
})

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

const tempDirs: string[] = []
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

mock.module('../logger', () => createLoggerModuleStub())

// Spread the real namespace: `mock.module` replaces the whole module for every
// later file in the same test process, so a partial factory would strip exports
// such as SOURCE_CREDENTIAL_TYPES from unrelated suites.
mock.module('@craft-agent/shared/credentials', () => ({
  ...realCredentials,
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
  // output-language.ts reads the persisted UI language; no preference here
  // means Deepgram gets automatic detection instead of a forced `en`.
  getPersistedUiLanguage: () => undefined,
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

const {
  MeetingService,
  HERMES_PLUGIN_TIMEOUT_MS,
  MEETINGS_SHUTDOWN_DEADLINE_MS,
  shutdownMeetingCaptures,
  relaunchAfterSealingCaptures,
} = await import('./meeting-service')

function createBrowserPaneManager(): BrowserPaneManager {
  const instances = new Map<string, { id: string }>()
  let nextId = 0
  return {
    createInstance: mock((_id?: string, _options?: unknown) => {
      const id = `browser-${++nextId}`
      instances.set(id, { id })
      return id
    }),
    getLiveInstance: mock((id: string) => instances.get(id)),
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
    expect(existsSync(join(meetingsDir, 'meetings.json'))).toBe(true)
    expect(existsSync(join(meetingsDir, 'transcripts', `${record.id}.json`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'summaries', `${record.id}.md`))).toBe(true)
    expect(existsSync(join(meetingsDir, 'meetings.json.tmp'))).toBe(false)

    const reloaded = new MeetingService(createBrowserPaneManager())
    expect(reloaded.list(workspaceRoot).map(item => item.id)).toEqual([record.id])
  })

  it('backs up a corrupt meetings.json instead of clobbering it', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    mkdirSync(meetingsDir, { recursive: true })
    writeFileSync(join(meetingsDir, 'meetings.json'), '{ this is not json', 'utf8')

    const service = new MeetingService(createBrowserPaneManager())
    expect(service.list(workspaceRoot)).toEqual([])

    const backups = readdirSync(meetingsDir).filter((f) => f.startsWith('meetings.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(meetingsDir, backups[0]!), 'utf8')).toBe('{ this is not json')

    // Próximo write cria um store novo e válido sem tocar no backup.
    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'craft', transcribe: false })
    const store = JSON.parse(readFileSync(join(meetingsDir, 'meetings.json'), 'utf8')) as { meetings: Array<{ id: string }> }
    expect(store.meetings.map((m) => m.id)).toEqual([record.id])
  })

  it('skips orphan recording sweep while a corrupt backup exists', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
    const recordingsDir = join(meetingsDir, 'recordings')
    mkdirSync(recordingsDir, { recursive: true })
    writeFileSync(join(meetingsDir, 'meetings.json'), 'garbage', 'utf8')
    writeFileSync(join(recordingsDir, 'orphan.webm'), 'webm-bytes', 'utf8')

    const service = new MeetingService(createBrowserPaneManager())
    service.list(workspaceRoot)

    // O .webm sobrevive: os registros que o referenciam podem estar no backup.
    expect(existsSync(join(recordingsDir, 'orphan.webm'))).toBe(true)
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

  it('keeps an interrupted craft recording on disk and marks it partial after a restart', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-partial-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const recordingPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'partial-bytes')

    // Referência desde o primeiro byte: é o que tira o parcial da mira do sweep.
    service.attachRecordingTarget(workspaceRoot, record.id, {
      outputPath: recordingPath,
      mimeType: 'video/webm;codecs=vp9,opus',
    })
    expect(service.status(workspaceRoot, record.id)?.recording).toEqual({
      path: recordingPath,
      mimeType: 'video/webm;codecs=vp9,opus',
      bytesWritten: 0,
      durationMs: 0,
      partial: true,
    })
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')

    // Crash/quit: nenhum finalize, nenhum completeRecording. Próximo boot:
    const reloaded = new MeetingService(createBrowserPaneManager())
    const afterBoot = reloaded.list(workspaceRoot).find(item => item.id === record.id)

    expect(existsSync(recordingPath)).toBe(true)
    expect(afterBoot?.status).toBe('stopped')
    expect(afterBoot?.recording?.partial).toBe(true)
  })

  it('clears the partial mark when the recording is sealed', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-sealed-'))
    tempDirs.push(workspaceRoot)

    const service = new MeetingService(createBrowserPaneManager())
    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const recordingPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'recordings', `${record.id}.webm`)
    mkdirSync(dirname(recordingPath), { recursive: true })
    writeFileSync(recordingPath, 'sealed-bytes')

    service.attachRecordingTarget(workspaceRoot, record.id, {
      outputPath: recordingPath,
      mimeType: 'video/webm',
    })
    await service.completeRecording('ws-test', workspaceRoot, record.id, {
      outputPath: recordingPath,
      bytesWritten: 12,
      durationMs: 3000,
      mimeType: 'video/webm',
    })

    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.recording?.partial).toBeFalsy()
    expect(sealed?.recording?.bytesWritten).toBe(12)
    expect(sealed?.status).toBe('stopped')
  })

  it('reuses the live craft record for the same meeting on the same pane', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-dedupe-'))
    tempDirs.push(workspaceRoot)

    const paneManager = createBrowserPaneManager()
    const service = new MeetingService(paneManager)
    // Caminho da página: cria o pane, sem browserInstanceId explícito.
    const fromPage = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })
    // Caminho da toolbar: aponta o mesmo pane e a mesma reunião.
    const fromToolbar = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      browserInstanceId: fromPage.browserInstanceId,
      transcribe: false,
    })

    expect(fromToolbar.id).toBe(fromPage.id)
    expect(service.list(workspaceRoot)).toHaveLength(1)
    expect(paneManager.createInstance).toHaveBeenCalledTimes(1)
  })

  it('creates a new record for a different meeting on the same pane or after the previous stopped', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-dedupe-new-'))
    tempDirs.push(workspaceRoot)

    const paneManager = createBrowserPaneManager()
    const service = new MeetingService(paneManager)
    const first = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      transcribe: false,
    })

    const differentMeeting = await service.start(workspaceRoot, {
      urlOrCode: 'xyz-vwqr-stu',
      captureMode: 'craft',
      browserInstanceId: first.browserInstanceId,
      transcribe: false,
    })
    expect(differentMeeting.id).not.toBe(first.id)

    service.stop('ws-test', workspaceRoot, first.id)
    const afterStop = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'craft',
      browserInstanceId: first.browserInstanceId,
      transcribe: false,
    })
    expect(afterStop.id).not.toBe(first.id)
    expect(service.list(workspaceRoot)).toHaveLength(3)
  })

  it('reconciles orphan .webm recordings on first ensureLoaded and keeps referenced files', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-orphans-'))
    tempDirs.push(workspaceRoot)

    const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
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
    // i18n falls back to en in tests (no language set in this process)
    expect(transcript.message).toContain('interrupted')
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

describe('Hermes plugin timeouts', () => {
  it('bounds every plugin command with a positive default timeout', () => {
    for (const command of ['start', 'status', 'transcript', 'stop'] as const) {
      expect(HERMES_PLUGIN_TIMEOUT_MS[command]).toBeGreaterThan(0)
      expect(HERMES_PLUGIN_TIMEOUT_MS[command]).toBeLessThanOrEqual(60_000)
    }
  })
})

type PluginCommand = 'start' | 'status' | 'transcript' | 'stop'
function installHermesPluginMock(service: InstanceType<typeof MeetingService>, calls: PluginCommand[]): void {
  ;(service as unknown as { runHermesMeetPlugin: (command: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
    async (command: PluginCommand) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world', 'Bob: hi'], total: 2 }
      return { ok: true, pid: 123 }
    }
}

type ServiceInternals = {
  runHermesMeetPlugin: (command: PluginCommand, payload?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>
  getWorkspaceState: (workspaceRootPath: string) => object
  runHermesHealthCheck: (state: object, meetingId: string) => Promise<void>
  pollHermesTranscript: (state: object, meetingId: string) => Promise<void>
  persistHermesTranscript: (state: object, meetingId: string, lines: string[], options: { seal: boolean }) => unknown
  persist: (state: { records: Map<string, { status: string }> }) => void
  hermesFinalizations: Map<string, Promise<unknown>>
  pendingDeletions: Set<string>
  generateAgentSummary: (workspaceId: string, workspaceRootPath: string, meetingId: string, segments: MeetingTranscriptSegment[]) => Promise<void>
  healthCheckTimers: Map<string, unknown>
  transcriptPollTimers: Map<string, unknown>
  botReadyTimeoutMs: number
}

/** White-box access to the capture internals the lifecycle contract is built on. */
function internals(service: InstanceType<typeof MeetingService>): ServiceInternals {
  return service as unknown as ServiceInternals
}

function endReasonOf(record: MeetingRecord | null): string | undefined {
  return (record as (MeetingRecord & { endReason?: string }) | null)?.endReason
}

/**
 * Terminal capture paths are fire-and-forget (`void this.finalizeHermesCapture`),
 * so the public API exposes no promise to await — poll the observable record or
 * transcript state instead, with a bounded deadline so a regression fails fast.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 10)
    await promise
  }
}

describe('Hermes capture transcript delivery', () => {
  it('fetches the bot transcript before stopping and persists it as ready', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(record.status).toBe('running')

    service.stop('ws-1', workspaceRoot, record.id)

    // finalizeHermesCapture é fire-and-forget: aguardar o transcript assentar.
    const deadline = Date.now() + 2_000
    let transcript = service.transcript(workspaceRoot, record.id)
    while (transcript.status !== 'ready' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      transcript = service.transcript(workspaceRoot, record.id)
    }
    expect(transcript.status).toBe('ready')
    expect(transcript.transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])
    expect(transcript.transcript[0]!.speaker).toBe('Alice')
    // transcript buscado ANTES do stop (stop limpa o ponteiro ativo do plugin).
    expect(calls.indexOf('transcript')).toBeLessThan(calls.lastIndexOf('stop'))
  })

  it('demotes to unavailable when the bot has no transcript lines', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    ;(service as unknown as { runHermesMeetPlugin: (c: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
      async (c: PluginCommand) => (c === 'status' ? { ok: true, inCall: true } : c === 'transcript' ? { ok: true, lines: [], total: 0 } : { ok: true })

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.stop('ws-1', workspaceRoot, record.id)
    const deadline = Date.now() + 2_000
    let transcript = service.transcript(workspaceRoot, record.id)
    while (transcript.status === 'placeholder' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      transcript = service.transcript(workspaceRoot, record.id)
    }
    expect(transcript.status).toBe('unavailable')
  })
})

describe('Hermes bot lifecycle', () => {
  it('rejects a second concurrent hermes meeting', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    await expect(service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })).rejects.toThrow()
    // Nenhum segundo pm.start disparado.
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
  })

  it('stops the bot when start fails after pm.start succeeded', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    ;(service as unknown as { botReadyTimeoutMs: number }).botReadyTimeoutMs = 100
    const calls: PluginCommand[] = []
    ;(service as unknown as { runHermesMeetPlugin: (c: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
      async (c: PluginCommand) => {
        calls.push(c)
        // status nunca chega em inCall/lobby → start() lança "did not reach the lobby"
        if (c === 'status') return { ok: true, alive: true }
        return { ok: true, pid: 1 }
      }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(record.status).toBe('error')
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toContain('stop')
  }, 30_000)

  it('stops the bot and cleans up when a live hermes meeting is deleted', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.deleteMeeting(workspaceRoot, record.id)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toContain('stop')
  })

  it('does not start a health check for hermes meetings with transcribe:false', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes', transcribe: false })
    expect(calls).toHaveLength(0) // nem start de bot, nem status de health check
    expect((service as unknown as { healthCheckTimers: Map<string, unknown> }).healthCheckTimers.size).toBe(0)
  })
})

describe('Hermes terminal finalization', () => {
  it('fetches and persists the transcript before stopping when the pane closes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(record.status).toBe('running')

    // O usuário fecha o pane do browser sem passar pelo botão Stop.
    panes.destroyInstance(record.browserInstanceId)
    service.list(workspaceRoot)

    await waitFor(() => service.transcript(workspaceRoot, record.id).status === 'ready')
    const transcript = service.transcript(workspaceRoot, record.id)
    expect(transcript.status).toBe('ready')
    expect(transcript.transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])

    const transcriptIndex = calls.indexOf('transcript')
    const stopIndex = calls.indexOf('stop')
    expect(transcriptIndex).toBeGreaterThan(-1)
    expect(stopIndex).toBeGreaterThan(transcriptIndex)

    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('pane_closed')
  })

  it('finalizes exactly once when the pane close and the health check race', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    let exited = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return exited ? { ok: true, exited: true } : { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      return { ok: true, pid: 7 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    exited = true
    panes.destroyInstance(record.browserInstanceId)

    // Ambos os sinais terminais observam a reunião ainda `running`.
    await Promise.all([
      Promise.resolve().then(() => { service.list(workspaceRoot) }),
      internals(service).runHermesHealthCheck(state, record.id),
    ])
    await waitFor(() => service.transcript(workspaceRoot, record.id).status === 'ready')

    expect(calls.filter((c) => c === 'transcript')).toHaveLength(1)
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(service.transcript(workspaceRoot, record.id).transcript).toHaveLength(1)
  })

  it('seals the transcript and stops the bot when the health check sees the bot exit', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    let exited = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') {
        return exited ? { ok: true, exited: true, leaveReason: 'call_ended' } : { ok: true, alive: true, inCall: true }
      }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world', 'Bob: hi'], total: 2 }
      return { ok: true, pid: 9 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    exited = true

    // Pane segue vivo: só o bot terminou. Hoje isso deixava a reunião presa.
    await internals(service).runHermesHealthCheck(state, record.id)
    await waitFor(() => service.transcript(workspaceRoot, record.id).status === 'ready')

    expect(service.transcript(workspaceRoot, record.id).transcript).toHaveLength(2)
    expect(calls).toContain('stop')
    expect(calls.indexOf('transcript')).toBeLessThan(calls.indexOf('stop'))
    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('bot_exited')
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
  })

  it('ends as error when the bot exited and the transcript cannot be fetched', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    let exited = false
    internals(service).runHermesMeetPlugin = async (command) => {
      if (command === 'status') {
        return exited ? { ok: true, exited: true, error: 'bot crashed' } : { ok: true, alive: true, inCall: true }
      }
      if (command === 'transcript') return { ok: false, error: 'no active bot' }
      return { ok: true, pid: 11 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    exited = true

    await internals(service).runHermesHealthCheck(state, record.id)
    await waitFor(() => service.status(workspaceRoot, record.id)?.status === 'error')

    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('error')
    expect(final?.error).toContain('bot crashed')
    expect(endReasonOf(final)).toBe('bot_exited')
  })

  it('routes delete-while-running through the single finalization without leaving a transcript file', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)
    expect(existsSync(transcriptPath)).toBe(true)

    service.deleteMeeting(workspaceRoot, record.id)

    expect(internals(service).hermesFinalizations.has(record.id)).toBe(true)
    await internals(service).hermesFinalizations.get(record.id)

    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    // O record foi descartado: nada pode recriar o transcript depois do delete.
    expect(existsSync(transcriptPath)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
  })

  it('keeps explicit stop on the same fetch-then-stop path', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.stop('ws-1', workspaceRoot, record.id)
    await waitFor(() => service.transcript(workspaceRoot, record.id).status === 'ready')

    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('user_stop')
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
  })
})

function readPersistedTranscript(workspaceRoot: string, meetingId: string): { status: string; transcript: Array<{ text: string }>; updatedAt: number } {
  const path = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${meetingId}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as { status: string; transcript: Array<{ text: string }>; updatedAt: number }
}

describe('Hermes incremental transcript persistence', () => {
  it('writes polled lines to disk before any stop', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    let lines = ['Alice: hello world']
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines, total: lines.length }
      return { ok: true, pid: 3 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)

    await internals(service).pollHermesTranscript(state, record.id)
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: hello world'])

    lines = ['Alice: hello world', 'Bob: hi']
    await internals(service).pollHermesTranscript(state, record.id)
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])

    // Nada de stop: a reunião segue viva e o disco já tem o que foi capturado.
    expect(calls).not.toContain('stop')
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')
  })

  it('keeps the polled tail on disk when the process dies without finalizing', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    await internals(service).pollHermesTranscript(internals(service).getWorkspaceState(workspaceRoot), record.id)

    // Nenhum finalize: o próximo boot recarrega do disco (simula kill -9).
    const reloaded = new MeetingService(createBrowserPaneManager())
    const restored = reloaded.transcript(workspaceRoot, record.id)
    expect(restored.transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])
    expect(reloaded.status(workspaceRoot, record.id)?.status).toBe('stopped')
  })

  it('skips the write when a tick brings no new lines', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)

    await internals(service).pollHermesTranscript(state, record.id)
    const first = readPersistedTranscript(workspaceRoot, record.id)
    await internals(service).pollHermesTranscript(state, record.id)
    const second = readPersistedTranscript(workspaceRoot, record.id)

    expect(second.updatedAt).toBe(first.updatedAt)
  })

  it('recovers on the next tick after a failed fetch', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    let transcriptFails = true
    internals(service).runHermesMeetPlugin = async (command) => {
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') {
        return transcriptFails ? { ok: false, error: 'plugin timed out' } : { ok: true, lines: ['Alice: back online'], total: 1 }
      }
      return { ok: true, pid: 5 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)

    await internals(service).pollHermesTranscript(state, record.id)
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript).toEqual([])
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')

    transcriptFails = false
    await internals(service).pollHermesTranscript(state, record.id)
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: back online'])
  })

  it('never shrinks the persisted transcript when the sealing fetch fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    let transcriptFails = false
    internals(service).runHermesMeetPlugin = async (command) => {
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') {
        return transcriptFails ? { ok: false, error: 'no active bot' } : { ok: true, lines: ['Alice: hello world', 'Bob: hi'], total: 2 }
      }
      return { ok: true, pid: 6 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    await internals(service).pollHermesTranscript(internals(service).getWorkspaceState(workspaceRoot), record.id)

    // O bot morreu antes do seal: o fetch final falha, mas o tail já persistido fica.
    transcriptFails = true
    panes.destroyInstance(record.browserInstanceId)
    service.list(workspaceRoot)
    await waitFor(() => service.status(workspaceRoot, record.id)?.status === 'stopped')

    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])
    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('pane_closed')
  })

  it('stops polling once the meeting is no longer running', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)

    service.stop('ws-1', workspaceRoot, record.id)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(false)
  })
})

describe('bounded shutdown', () => {
  it('bounds the shutdown deadline', () => {
    expect(MEETINGS_SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0)
    expect(MEETINGS_SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(30_000)
  })

  it('adds no delay and touches no plugin when nothing is running', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'craft', transcribe: false })
    expect(await service.shutdown(50)).toBe('idle')
    expect(calls).toHaveLength(0)
  })

  it('seals an active capture before the app exits', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(await service.shutdown(2_000)).toBe('sealed')

    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])
    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('app_quit')
    expect(calls.indexOf('transcript')).toBeLessThan(calls.indexOf('stop'))
    expect(internals(service).healthCheckTimers.size).toBe(0)
    expect(internals(service).transcriptPollTimers.size).toBe(0)
  })

  it('seals active captures through the module-level quit hook', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    await shutdownMeetingCaptures(2_000)

    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('app_quit')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
  })

  it('gives up at the deadline when the plugin never returns, keeping the polled transcript', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const hung = Promise.withResolvers<Record<string, unknown>>()
    internals(service).runHermesMeetPlugin = async (command) => {
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      if (command === 'start') return { ok: true, pid: 12 }
      // `stop` nunca responde: o teardown do bot travou.
      return hung.promise
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const startedAt = Date.now()
    expect(await service.shutdown(100)).toBe('deadline')
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    // O seal já escreveu o tail antes de tentar parar o bot.
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript.map((s) => s.text)).toEqual(['Alice: hello world'])
    hung.resolve({ ok: true })
  })
})

describe('Hermes singleton stays busy until the capture is sealed', () => {
  it('refuses a Start while an explicit Stop is still sealing, and allows it after the seal settles', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    const sealGate = Promise.withResolvers<void>()
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') {
        await sealGate.promise
        return { ok: true, lines: ['Alice: hello world'], total: 1 }
      }
      return { ok: true, pid: 21 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.stop('ws-1', workspaceRoot, record.id)

    // O seal está em voo: o bot singleton segue ocupado e nada terminal foi anunciado.
    await expect(service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })).rejects.toThrow()
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(calls).not.toContain('stop')

    sealGate.resolve()
    await internals(service).hermesFinalizations.get(record.id)
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(endReasonOf(sealed)).toBe('user_stop')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')

    // Liberado só depois do settle.
    const next = await service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })
    expect(next.status).toBe('running')
    expect(calls.filter((c) => c === 'start')).toHaveLength(2)
  }, 30_000)

  it('refuses a Start while a delete-while-running seals, and purges only after transcript then stop', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    const sealGate = Promise.withResolvers<void>()
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') {
        await sealGate.promise
        return { ok: true, lines: ['Alice: hello world'], total: 1 }
      }
      return { ok: true, pid: 22 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)
    expect(existsSync(transcriptPath)).toBe(true)

    service.deleteMeeting(workspaceRoot, record.id)

    // Delete é observável na hora para a UI...
    expect(service.list(workspaceRoot).map((r) => r.id)).not.toContain(record.id)
    // ...mas o bot só é liberado depois de transcript → persist → stop.
    await expect(service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })).rejects.toThrow()
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(calls).not.toContain('stop')

    sealGate.resolve()
    await internals(service).hermesFinalizations.get(record.id)

    expect(calls.filter((c) => c === 'transcript')).toHaveLength(1)
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(calls.indexOf('transcript')).toBeLessThan(calls.indexOf('stop'))
    // Nada recria artefatos depois do cleanup.
    expect(existsSync(transcriptPath)).toBe(false)
    expect(service.status(workspaceRoot, record.id)).toBeNull()
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)

    const next = await service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })
    expect(next.status).toBe('running')
  }, 30_000)
})

describe('failed finalization rearms the retry path', () => {
  it('clears the in-flight entry and rearms health check and poll when the seal throws', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    let botGone = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') {
        return botGone ? { ok: true, exited: true, leaveReason: 'call_ended' } : { ok: true, alive: true, inCall: true }
      }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      return { ok: true, pid: 23 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    const realPersist = internals(service).persistHermesTranscript.bind(service)
    let persistFails = true
    internals(service).persistHermesTranscript = (persistState, meetingId, lines, options) => {
      if (persistFails) throw new Error('ENOSPC: no space left on device')
      return realPersist(persistState, meetingId, lines, options)
    }

    // O pane segue vivo: só o bot terminou, e o seal falha na persistência.
    botGone = true
    await internals(service).runHermesHealthCheck(state, record.id)

    // Falha transitória: nada fica preso na tabela de finalizações...
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    // ...e a reconciliação volta armada, então um sinal posterior retenta.
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(true)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')

    persistFails = false
    await internals(service).runHermesHealthCheck(state, record.id)
    await waitFor(() => service.status(workspaceRoot, record.id)?.status === 'stopped')

    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(endReasonOf(sealed)).toBe('bot_exited')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(false)
  })

  it('does not report a sealed shutdown when the seal throws', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    internals(service).persistHermesTranscript = () => { throw new Error('ENOSPC: no space left on device') }

    expect(await service.shutdown(2_000)).toBe('failed')
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')
  })
})

describe('health check bot-gone contract', () => {
  it('finalizes when the plugin reports no active meeting', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    let botGone = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      // Contrato real de plugins/google_meet/process_manager.status().
      if (command === 'status') return botGone ? { ok: false, reason: 'no active meeting' } : { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      return { ok: true, pid: 31 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    botGone = true

    await internals(service).runHermesHealthCheck(state, record.id)
    await waitFor(() => service.status(workspaceRoot, record.id)?.status === 'stopped')

    const final = service.status(workspaceRoot, record.id)
    expect(final?.status).toBe('stopped')
    expect(endReasonOf(final)).toBe('bot_exited')
    expect(calls.indexOf('transcript')).toBeLessThan(calls.indexOf('stop'))
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
  })

  it('keeps the meeting running when the plugin call itself fails without bot evidence', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    let transportFails = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') {
        // Forma que runHermesMeetPlugin devolve num timeout de exec: sem evidência do bot.
        return transportFails
          ? { ok: false, error: "Hermes Meet plugin 'status' failed or timed out: killed" }
          : { ok: true, alive: true, inCall: true }
      }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      return { ok: true, pid: 32 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const state = internals(service).getWorkspaceState(workspaceRoot)
    transportFails = true

    await internals(service).runHermesHealthCheck(state, record.id)

    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')
    expect(calls).not.toContain('stop')
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(true)
  })
})

describe('relaunch seals captures before exiting', () => {
  it('awaits the bounded shutdown before relaunch and exit', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    // `app.relaunch()` + `app.exit(0)` não emitem `before-quit`, então o seal
    // precisa acontecer aqui, antes de qualquer um dos dois.
    const order: string[] = []
    await relaunchAfterSealingCaptures({
      relaunch: () => { order.push(`relaunch:${service.status(workspaceRoot, record.id)?.status ?? 'missing'}`) },
      exit: () => { order.push('exit') },
    }, 2_000)

    expect(order).toEqual(['relaunch:stopped', 'exit'])
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
    expect(endReasonOf(service.status(workspaceRoot, record.id))).toBe('app_quit')
  })
})

function persistedMeetingIds(workspaceRoot: string): string[] {
  const storePath = join(getWorkspaceMeetingsPath(workspaceRoot), 'meetings.json')
  if (!existsSync(storePath)) return []
  const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { meetings?: Array<{ id: string }> }
  return (parsed.meetings ?? []).map((meeting) => meeting.id)
}

function persistedRecordStatus(workspaceRoot: string, meetingId: string): string | undefined {
  const storePath = join(getWorkspaceMeetingsPath(workspaceRoot), 'meetings.json')
  if (!existsSync(storePath)) return undefined
  const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { meetings?: Array<{ id: string; status: string }> }
  return (parsed.meetings ?? []).find((meeting) => meeting.id === meetingId)?.status
}

/**
 * Um pane pré-criado é reusado (`ownsBrowserInstance: false`), então nenhum
 * caminho terminal o destrói e `refreshLiveStatuses` não injeta finalizações
 * `pane_closed` extras enquanto o teste observa o retry.
 */
async function startOnSharedPane(
  service: InstanceType<typeof MeetingService>,
  panes: BrowserPaneManager,
  workspaceRoot: string,
  urlOrCode = 'abc-defg-hij',
): Promise<MeetingRecord> {
  const browserInstanceId = panes.createInstance(undefined, { show: true })
  return service.start(workspaceRoot, { urlOrCode, captureMode: 'hermes', browserInstanceId })
}

describe('delete-while-running survives a failed seal', () => {
  it('purges nothing, keeps the record active and lets a later delete seal and purge', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await startOnSharedPane(service, panes, workspaceRoot)
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)
    expect(existsSync(transcriptPath)).toBe(true)

    const realPersist = internals(service).persistHermesTranscript.bind(service)
    let persistFails = true
    internals(service).persistHermesTranscript = (state, meetingId, lines, options) => {
      if (persistFails) throw new Error('ENOSPC: no space left on device')
      return realPersist(state, meetingId, lines, options)
    }

    service.deleteMeeting(workspaceRoot, record.id)
    const failed = internals(service).hermesFinalizations.get(record.id)
    expect(failed).toBeDefined()
    expect(await failed).toBe('failed')

    // Nada foi purgado: o transcript e o record continuam no disco.
    expect(existsSync(transcriptPath)).toBe(true)
    expect(persistedMeetingIds(workspaceRoot)).toContain(record.id)
    // O bot não foi parado sem seal, então o record segue ativo e retomável.
    expect(calls).not.toContain('stop')
    // E o record não fica oculto para sempre atrás da intenção de delete.
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')
    expect(service.list(workspaceRoot).map((r) => r.id)).toContain(record.id)
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(true)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)

    // Retry depois que a persistência volta: agora sela e purga de verdade.
    persistFails = false
    service.deleteMeeting(workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(existsSync(transcriptPath)).toBe(false)
    expect(persistedMeetingIds(workspaceRoot)).not.toContain(record.id)
    expect(service.status(workspaceRoot, record.id)).toBeNull()
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(false)
  })
})

describe('delete that lands on an in-flight seal', () => {
  it('purges exactly once after the running seal, without a second transcript or stop', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    const sealGate = Promise.withResolvers<void>()
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') {
        await sealGate.promise
        return { ok: true, lines: ['Alice: hello world'], total: 1 }
      }
      return { ok: true, pid: 41 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)

    // Stop explícito abre a janela de seal...
    service.stop('ws-1', workspaceRoot, record.id)
    const inflight = internals(service).hermesFinalizations.get(record.id)
    expect(inflight).toBeDefined()
    // ...e o Delete chega enquanto ela está em voo.
    service.deleteMeeting(workspaceRoot, record.id)

    expect(service.list(workspaceRoot).map((r) => r.id)).not.toContain(record.id)
    await expect(service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })).rejects.toThrow()
    expect(calls).not.toContain('stop')

    sealGate.resolve()
    expect(await inflight).toBe('sealed')

    // Uma única sequência transcript → stop, e o Delete não foi perdido.
    expect(calls.filter((c) => c === 'transcript')).toHaveLength(1)
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(calls.indexOf('transcript')).toBeLessThan(calls.indexOf('stop'))
    expect(existsSync(transcriptPath)).toBe(false)
    expect(persistedMeetingIds(workspaceRoot)).not.toContain(record.id)
    expect(service.status(workspaceRoot, record.id)).toBeNull()
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)

    const next = await service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })
    expect(next.status).toBe('running')
  }, 30_000)

  it('does not purge and does not strand the delete when the in-flight seal fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await startOnSharedPane(service, panes, workspaceRoot)
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)
    const realPersist = internals(service).persistHermesTranscript.bind(service)
    let persistFails = true
    internals(service).persistHermesTranscript = (state, meetingId, lines, options) => {
      if (persistFails) throw new Error('ENOSPC: no space left on device')
      return realPersist(state, meetingId, lines, options)
    }

    service.stop('ws-1', workspaceRoot, record.id)
    const inflight = internals(service).hermesFinalizations.get(record.id)
    service.deleteMeeting(workspaceRoot, record.id)
    expect(await inflight).toBe('failed')

    expect(existsSync(transcriptPath)).toBe(true)
    expect(persistedMeetingIds(workspaceRoot)).toContain(record.id)
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')

    // A reunião segue ativa e com timers armados: selar aqui evita que um tick de
    // poll deste serviço estoure numa persistência ainda quebrada durante outro teste.
    persistFails = false
    service.deleteMeeting(workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(false)
  })
})

describe('bot stop must be confirmed before the capture is sealed', () => {
  it('keeps the meeting active and retryable when pm.stop times out', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    let stopConfirms = false
    internals(service).runHermesMeetPlugin = async (command) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      if (command === 'stop') {
        // Forma que runHermesMeetPlugin devolve num timeout de exec: sem prova de
        // que o bot saiu do call.
        return stopConfirms
          ? { ok: true, reason: 'Craft Meetings stopped' }
          : { ok: false, error: "Hermes Meet plugin 'stop' failed or timed out: killed" }
      }
      return { ok: true, pid: 42 }
    }

    const record = await startOnSharedPane(service, panes, workspaceRoot)
    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('failed')

    // Sem evidência do stop nada terminal é gravado e o bot segue ocupado.
    const stillRunning = service.status(workspaceRoot, record.id)
    expect(stillRunning?.status).toBe('running')
    expect(stillRunning?.endedAt).toBeUndefined()
    expect(endReasonOf(stillRunning)).toBeUndefined()
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(true)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)

    stopConfirms = true
    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(endReasonOf(sealed)).toBe('user_stop')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
  })

  it('accepts the no-active-meeting answer as proof the bot is already gone', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    internals(service).runHermesMeetPlugin = async (command) => {
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world'], total: 1 }
      // Contrato real de plugins/google_meet/process_manager.stop().
      if (command === 'stop') return { ok: false, reason: 'no active meeting' }
      return { ok: true, pid: 43 }
    }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(endReasonOf(sealed)).toBe('user_stop')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
  })
})

describe('optional summary never holds the bot singleton', () => {
  it('releases the mutex and the shutdown result while the summary is still pending', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const summaryGate = Promise.withResolvers<void>()
    let summaryStarted = false
    internals(service).generateAgentSummary = async () => {
      summaryStarted = true
      await summaryGate.promise
    }

    const record = await service.start(workspaceRoot, {
      urlOrCode: 'abc-defg-hij',
      captureMode: 'hermes',
      summarizeOnEnd: true,
    })

    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    // O seal terminou com o summary ainda pendente.
    expect(summaryStarted).toBe(true)
    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)

    // Nem o próximo Start nem o quit esperam pelo resumo.
    const next = await service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })
    expect(next.status).toBe('running')
    expect(await service.shutdown(2_000)).toBe('sealed')

    summaryGate.resolve()
  }, 10_000)

  it('absorbs a late summary failure without an unhandled rejection', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    installHermesPluginMock(service, [])

    const summaryGate = Promise.withResolvers<void>()
    internals(service).generateAgentSummary = async () => {
      await summaryGate.promise
      throw new Error('summary backend exploded')
    }

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const record = await service.start(workspaceRoot, {
        urlOrCode: 'abc-defg-hij',
        captureMode: 'hermes',
        followUpOnEnd: true,
      })
      service.stop('ws-1', workspaceRoot, record.id)
      expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

      summaryGate.resolve()
      // Duas voltas de macrotask: tempo de o runtime classificar a rejeição.
      await waitFor(() => unhandled.length > 0, 50)
      expect(unhandled).toEqual([])
      expect(service.status(workspaceRoot, record.id)?.status).toBe('stopped')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('purge is transactional against the store write', () => {
  it('keeps record and transcript coherent, frees the delete intent and purges on a later retry', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await startOnSharedPane(service, panes, workspaceRoot)
    const transcriptPath = join(getWorkspaceMeetingsPath(workspaceRoot), 'transcripts', `${record.id}.json`)

    // Falha localizada na única escrita do purge: o store já sem o record.
    // O seal (que escreve com o record ainda presente) roda inteiro.
    const realPersist = internals(service).persist.bind(service)
    let purgePersistFails = true
    internals(service).persist = (state) => {
      if (purgePersistFails && !state.records.has(record.id)) {
        throw new Error('ENOSPC: no space left on device')
      }
      realPersist(state)
    }

    service.deleteMeeting(workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    // O store não persistiu, então nada pode ter sido removido: disco e memória
    // continuam de acordo e o record selado volta visível.
    expect(persistedMeetingIds(workspaceRoot)).toContain(record.id)
    expect(existsSync(transcriptPath)).toBe(true)
    expect(service.status(workspaceRoot, record.id)?.status).toBe('stopped')
    expect(service.list(workspaceRoot).map((r) => r.id)).toContain(record.id)
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
    expect(readPersistedTranscript(workspaceRoot, record.id).transcript).toHaveLength(2)
    // A intenção de delete não fica presa atrás da falha.
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)

    // Retry depois que a escrita volta: agora o purge remove tudo, sem tocar no bot.
    purgePersistFails = false
    service.deleteMeeting(workspaceRoot, record.id)

    expect(service.status(workspaceRoot, record.id)).toBeNull()
    expect(persistedMeetingIds(workspaceRoot)).not.toContain(record.id)
    expect(existsSync(transcriptPath)).toBe(false)
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(internals(service).pendingDeletions.has(record.id)).toBe(false)
  })
})

describe('terminal status is transactional against the store write', () => {
  it('reports failed, keeps the record running on disk and in memory, and rearms for a retry', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const panes = createBrowserPaneManager()
    const service = new MeetingService(panes)
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await startOnSharedPane(service, panes, workspaceRoot)

    // Falha localizada na escrita do status terminal, depois de o stop já ter
    // sido confirmado: o store só falha quando o record deixou de estar ativo.
    const realPersist = internals(service).persist.bind(service)
    let terminalPersistFails = true
    internals(service).persist = (state) => {
      const pending = state.records.get(record.id)
      if (terminalPersistFails && pending && !['starting', 'running'].includes(pending.status)) {
        throw new Error('ENOSPC: no space left on device')
      }
      realPersist(state)
    }

    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('failed')
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)

    // Nada terminal chegou ao disco, então a memória também não pode parecer
    // terminal: senão o rearme ignoraria um record que o disco ainda vê ativo.
    expect(persistedRecordStatus(workspaceRoot, record.id)).toBe('running')
    expect(service.status(workspaceRoot, record.id)?.status).toBe('running')
    expect(service.status(workspaceRoot, record.id)?.endedAt).toBeUndefined()
    expect(endReasonOf(service.status(workspaceRoot, record.id))).toBeUndefined()
    expect(internals(service).hermesFinalizations.has(record.id)).toBe(false)
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(true)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(true)

    // Sinal posterior, com a escrita de volta: agora sela como terminal.
    terminalPersistFails = false
    service.stop('ws-1', workspaceRoot, record.id)
    expect(await internals(service).hermesFinalizations.get(record.id)).toBe('sealed')

    const sealed = service.status(workspaceRoot, record.id)
    expect(sealed?.status).toBe('stopped')
    expect(endReasonOf(sealed)).toBe('user_stop')
    expect(persistedRecordStatus(workspaceRoot, record.id)).toBe('stopped')
    expect(service.transcript(workspaceRoot, record.id).status).toBe('ready')
    expect(internals(service).healthCheckTimers.has(record.id)).toBe(false)
    expect(internals(service).transcriptPollTimers.has(record.id)).toBe(false)
  })
})

describe('meetings suite isolation', () => {
  it('leaves the real user config root untouched', () => {
    expect(listRealWorkspaces()).toEqual(realWorkspacesBefore)
  })
})
