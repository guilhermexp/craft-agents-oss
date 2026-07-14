import { describe, expect, it, mock } from 'bun:test'
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserPaneManager } from '../browser-pane-manager'

mock.module('../logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { mainLog: logger }
})

const { RecordingService } = await import('./recording-service')

type RecordingsMap = Map<string, {
  id: string
  workspaceId: string
  browserInstanceId: string
  meetingId?: string
  outputPath: string
  stream: ReturnType<typeof createWriteStream>
  startedAt: number
  bytesWritten: number
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
        stream,
        startedAt: Date.now(),
        bytesWritten: 13,
      })

      const aborted = service.abort('rec-1')
      expect(aborted).toEqual({ meetingId: 'meeting-1', workspaceId: 'ws-test' })

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
