import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'
import { createLoggerModuleStub } from '../__tests__/logger-module-stub'

mock.module('../logger', () => createLoggerModuleStub())

/**
 * Meetings storage resolves the config root on every call, so this suite writes
 * recording metadata into one tmpdir instead of the user's real `~/.craft-agent`.
 */
const configRoot = mkdtempSync(join(tmpdir(), 'craft-config-recording-'))
process.env.CRAFT_CONFIG_DIR = configRoot

const { RecordingService } = await import('./recording-service')

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

type RecordingsMap = Map<string, {
  id: string
  workspaceId: string
  browserInstanceId: string
  meetingId?: string
  outputPath: string
  mimeType: string
  stream: ReturnType<typeof createWriteStream>
  startedAt: number
  bytesWritten: number
  streamError?: Error
}>

describe('RecordingService.abort', () => {
  it('removes the partial file, returns the owning ids, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-recording-abort-'))
    try {
      const outputPath = join(dir, 'rec-1.webm')
      const stream = createWriteStream(outputPath)
      await new Promise<void>((resolve, reject) => {
        stream.write('partial-bytes', (err) => (err ? reject(err) : resolve()))
      })
      expect(existsSync(outputPath)).toBe(true)

      const service = new RecordingService({} as BrowserPaneManager)
      const recordings = (service as unknown as { recordings: RecordingsMap }).recordings
      recordings.set('rec-1', {
        id: 'rec-1',
        workspaceId: 'ws-test',
        browserInstanceId: 'browser-1',
        meetingId: 'meeting-1',
        outputPath,
        mimeType: 'video/webm',
        stream,
        startedAt: Date.now(),
        bytesWritten: 13,
      })

      const aborted = service.abort('rec-1')
      // O pane dono viaja no retorno: o handler precisa dele para liberar o
      // captureLock da instância sem espiar a tabela de gravações.
      expect(aborted).toEqual({ meetingId: 'meeting-1', workspaceId: 'ws-test', browserInstanceId: 'browser-1' })

      // The partial .webm is unlinked once the stream closes.
      for (let i = 0; i < 50 && existsSync(outputPath); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(existsSync(outputPath)).toBe(false)

      // Second abort is a no-op: the recording is gone from the map.
      expect(service.abort('rec-1')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RecordingService.prepare', () => {
  it('resolves the recordings dir from the provided workspaceRoot', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-recording-prepare-'))
    const recordingsDir = join(getWorkspaceMeetingsPath(workspaceRoot), 'recordings')
    tempDirs.push(workspaceRoot)

    const service = new RecordingService({ getLiveInstance: () => ({}) } as unknown as BrowserPaneManager)
    const result = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-1',
      meetingId: 'meeting-1',
      mimeType: 'video/webm;codecs=vp9,opus',
    })
    expect(result.meetingId).toBe('meeting-1')
    expect(result.outputPath.startsWith(recordingsDir)).toBe(true)
    expect(existsSync(recordingsDir)).toBe(true)

    service.abort(result.recordingId)
  })
})

describe('RecordingService.append', () => {
  it('writes chunks and awaits drain under backpressure', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-recording-append-'))
    const recordingsDir = join(getWorkspaceMeetingsPath(workspaceRoot), 'recordings')
    tempDirs.push(workspaceRoot)

    const service = new RecordingService({ getLiveInstance: () => ({}) } as unknown as BrowserPaneManager)
    const { recordingId } = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-1',
      mimeType: 'video/webm',
    })
    await service.append(recordingId, new Uint8Array([1, 2, 3, 4]))
    const recordings = (service as unknown as { recordings: RecordingsMap }).recordings
    expect(recordings.get(recordingId)?.bytesWritten).toBe(4)

    service.abort(recordingId)
  })
})

describe('RecordingService.finalize', () => {
  it('reuses the mime stored at prepare and reports the owning pane', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-recording-finalize-'))
    tempDirs.push(workspaceRoot)

    const service = new RecordingService({ getLiveInstance: () => ({}) } as unknown as BrowserPaneManager)
    const { recordingId } = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-1',
      meetingId: 'meeting-1',
      mimeType: 'video/webm;codecs=vp9,opus',
    })
    await service.append(recordingId, new Uint8Array([1, 2, 3]))

    // Sem mime explícito: o main sela sozinho no quit, quando o renderer já
    // não existe para informá-lo.
    const result = await service.finalize(recordingId)
    expect(result.mimeType).toBe('video/webm;codecs=vp9,opus')
    expect(result.browserInstanceId).toBe('browser-1')
    expect(result.bytesWritten).toBe(3)
    expect(existsSync(result.outputPath)).toBe(true)
  })
})

describe('RecordingService.finalizeAll', () => {
  it('seals every active recording and skips the one whose stream failed', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-recording-finalize-all-'))
    tempDirs.push(workspaceRoot)

    const service = new RecordingService({ getLiveInstance: () => ({}) } as unknown as BrowserPaneManager)
    const good = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-1',
      meetingId: 'meeting-good',
      mimeType: 'video/webm',
    })
    const broken = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-2',
      meetingId: 'meeting-broken',
      mimeType: 'video/webm',
    })
    await service.append(good.recordingId, new Uint8Array([1, 2]))

    const recordings = (service as unknown as { recordings: RecordingsMap }).recordings
    recordings.get(broken.recordingId)!.streamError = new Error('disk on fire')

    const results = await service.finalizeAll()

    // Uma stream ruim não bloqueia o seal das outras.
    expect(results.map(r => r.meetingId)).toEqual(['meeting-good'])
    expect(results[0]!.browserInstanceId).toBe('browser-1')
    // Nada permanece ativo: uma gravação com erro também sai da tabela.
    expect(recordings.size).toBe(0)
  })
})

describe('RecordingService.finalizeForInstance', () => {
  it('finalizes only the recordings owned by that pane', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-recording-finalize-instance-'))
    tempDirs.push(workspaceRoot)

    const service = new RecordingService({ getLiveInstance: () => ({}) } as unknown as BrowserPaneManager)
    const mine = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-1',
      meetingId: 'meeting-mine',
      mimeType: 'video/webm',
    })
    const other = service.prepare({
      workspaceId: 'ws-test',
      workspaceRoot,
      browserInstanceId: 'browser-2',
      meetingId: 'meeting-other',
      mimeType: 'video/webm',
    })

    const results = await service.finalizeForInstance('browser-1')

    expect(results.map(r => r.recordingId)).toEqual([mine.recordingId])
    const recordings = (service as unknown as { recordings: RecordingsMap }).recordings
    expect([...recordings.keys()]).toEqual([other.recordingId])

    service.abort(other.recordingId)
  })
})

describe('recording suite isolation', () => {
  it('leaves the real user config root untouched', () => {
    expect(listRealWorkspaces()).toEqual(realWorkspacesBefore)
  })
})
