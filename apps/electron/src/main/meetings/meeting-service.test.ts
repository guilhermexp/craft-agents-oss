import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'

const tempDirs: string[] = []
const metadataDirs: string[] = []
const credentials = new Map<string, { value: string }>()

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
})
