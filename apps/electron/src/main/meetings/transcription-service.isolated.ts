// Isolated: meeting-service.test.ts mocks './transcription-service' via
// mock.module, which leaks across test files in the same bun process. This
// file needs the real module, so it runs in its own `bun test` invocation.
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('../logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { mainLog: logger }
})

const { TranscriptionService } = await import('./transcription-service')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('TranscriptionService.transcribe', () => {
  it('streams the file as the request body and passes an AbortSignal to fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-transcription-'))
    try {
      const filePath = join(dir, 'recording.webm')
      writeFileSync(filePath, 'fake-audio-bytes')

      let captured: { init?: RequestInit & { duplex?: string } } = {}
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        captured = { init: init as RequestInit & { duplex?: string } }
        return new Response(JSON.stringify({
          results: {
            utterances: [{ start: 0, end: 1.5, transcript: 'hello world', speaker: 0 }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch

      const service = new TranscriptionService()
      const result = await service.transcribe({
        filePath,
        model: 'nova-3',
        apiKey: 'dg-test-key',
        mimeType: 'video/webm;codecs=vp9,opus',
      })

      // Body must be a stream from disk, never the whole file buffered in RAM.
      const body = captured.init?.body
      expect(body instanceof ReadableStream).toBe(true)
      expect(Buffer.isBuffer(body)).toBe(false)
      expect(captured.init?.duplex).toBe('half')
      expect(captured.init?.signal instanceof AbortSignal).toBe(true)

      expect(result.segments.map(segment => segment.text)).toEqual(['hello world'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
