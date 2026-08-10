/**
 * Favicon transport unit tests.
 *
 * These defend the guards that keep a page-chosen favicon URL out of the
 * privileged renderer: scheme allowlist, content-type allowlist (SVG stays
 * out), the hard byte ceiling on both the declared and the actual body, and
 * the "any failure is a silent null" contract. Pure logic — no Electron
 * session, no real socket; the fetcher is injected.
 */

import { describe, it, expect } from 'bun:test'
import {
  ALLOWED_FAVICON_CONTENT_TYPES,
  FAVICON_MAX_BYTES,
  fetchFaviconDataUrl,
  isFetchableFaviconUrl,
  normalizeFaviconContentType,
  toFaviconDataUrl,
  type FaviconFetcher,
  type FaviconHttpResponse,
} from '../favicon-transport'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface StubResponseInit {
  ok?: boolean
  status?: number
  contentType?: string | null
  contentLength?: string | null
  bytes?: Uint8Array
  /** Emit the body as a stream in these chunks instead of a single buffer. */
  chunks?: Uint8Array[]
}

function stubResponse(init: StubResponseInit = {}): FaviconHttpResponse {
  const bytes = init.bytes ?? PNG_BYTES
  const headers = new Map<string, string>()
  const contentType = init.contentType === undefined ? 'image/png' : init.contentType
  if (contentType !== null) headers.set('content-type', contentType)
  if (init.contentLength) headers.set('content-length', init.contentLength)

  const chunks = init.chunks
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: chunks
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        })
      : null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }
}

/** Fetcher that records what it was called with, so "never requested" is provable. */
function recordingFetcher(response: FaviconHttpResponse | (() => Promise<FaviconHttpResponse>)) {
  const calls: Array<{ url: string; signal: AbortSignal }> = []
  const fetch: FaviconFetcher = async (url, init) => {
    calls.push({ url, signal: init.signal })
    return typeof response === 'function' ? await response() : response
  }
  return { calls, fetch }
}

describe('isFetchableFaviconUrl', () => {
  it('accepts only http and https', () => {
    expect(isFetchableFaviconUrl('http://localhost:3003/favicon.ico')).toBe(true)
    expect(isFetchableFaviconUrl('https://example.com/favicon.png?v=2')).toBe(true)
  })

  it('rejects local-file, inline and internal schemes chosen by the page', () => {
    expect(isFetchableFaviconUrl('file:///etc/passwd')).toBe(false)
    expect(isFetchableFaviconUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isFetchableFaviconUrl('javascript:alert(1)')).toBe(false)
    expect(isFetchableFaviconUrl('chrome://settings')).toBe(false)
    expect(isFetchableFaviconUrl('craftagents://settings')).toBe(false)
    expect(isFetchableFaviconUrl('not a url')).toBe(false)
    expect(isFetchableFaviconUrl('')).toBe(false)
    expect(isFetchableFaviconUrl(null)).toBe(false)
  })
})

describe('normalizeFaviconContentType', () => {
  it('accepts the raster allowlist and strips parameters and case', () => {
    expect(normalizeFaviconContentType('image/png')).toBe('image/png')
    expect(normalizeFaviconContentType('IMAGE/PNG; charset=binary')).toBe('image/png')
    expect(normalizeFaviconContentType(' image/x-icon ')).toBe('image/x-icon')
    expect(normalizeFaviconContentType('image/vnd.microsoft.icon')).toBe('image/vnd.microsoft.icon')
    expect(normalizeFaviconContentType('image/gif')).toBe('image/gif')
    expect(normalizeFaviconContentType('image/jpeg')).toBe('image/jpeg')
    expect(normalizeFaviconContentType('image/webp')).toBe('image/webp')
  })

  it('rejects svg — a page-chosen SVG must not reach the privileged renderer parser', () => {
    expect('image/svg+xml' in ALLOWED_FAVICON_CONTENT_TYPES).toBe(false)
    expect(normalizeFaviconContentType('image/svg+xml')).toBe(null)
  })

  it('rejects non-image and missing content types', () => {
    expect(normalizeFaviconContentType('text/html')).toBe(null)
    expect(normalizeFaviconContentType('application/octet-stream')).toBe(null)
    expect(normalizeFaviconContentType('')).toBe(null)
    expect(normalizeFaviconContentType(null)).toBe(null)
  })
})

describe('toFaviconDataUrl', () => {
  it('produces a well-formed base64 data URL that round-trips the bytes', () => {
    const dataUrl = toFaviconDataUrl('image/png', PNG_BYTES)
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
    const decoded = new Uint8Array(Buffer.from(dataUrl!.split(',')[1]!, 'base64'))
    expect(decoded).toEqual(PNG_BYTES)
  })

  it('refuses an empty body or a body past the ceiling', () => {
    expect(toFaviconDataUrl('image/png', new Uint8Array(0))).toBe(null)
    expect(toFaviconDataUrl('image/png', new Uint8Array(FAVICON_MAX_BYTES + 1))).toBe(null)
    expect(toFaviconDataUrl('image/png', new Uint8Array(FAVICON_MAX_BYTES))).not.toBe(null)
  })
})

describe('fetchFaviconDataUrl', () => {
  it('returns a data URL for an allowed raster response', async () => {
    const { calls, fetch } = recordingFetcher(stubResponse())
    const result = await fetchFaviconDataUrl('http://localhost:3003/favicon.ico', { fetch })
    expect(result).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:3003/favicon.ico')
  })

  it('never issues a request for a rejected scheme', async () => {
    const { calls, fetch } = recordingFetcher(stubResponse())
    expect(await fetchFaviconDataUrl('file:///etc/passwd', { fetch })).toBe(null)
    expect(await fetchFaviconDataUrl('data:image/png;base64,AAAA', { fetch })).toBe(null)
    expect(calls).toHaveLength(0)
  })

  it('rejects a disallowed content type', async () => {
    const svg = recordingFetcher(stubResponse({ contentType: 'image/svg+xml' }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.svg', svg)).toBe(null)

    const html = recordingFetcher(stubResponse({ contentType: 'text/html' }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', html)).toBe(null)

    const missing = recordingFetcher(stubResponse({ contentType: null }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', missing)).toBe(null)
  })

  it('rejects a declared content-length past the ceiling without reading the body', async () => {
    let bodyRead = false
    const response: FaviconHttpResponse = {
      ...stubResponse({ contentLength: String(FAVICON_MAX_BYTES + 1) }),
      arrayBuffer: async () => {
        bodyRead = true
        return new ArrayBuffer(0)
      },
    }
    const { fetch } = recordingFetcher(response)
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch })).toBe(null)
    expect(bodyRead).toBe(false)
  })

  it('aborts a chunked body that grows past the ceiling', async () => {
    const chunk = new Uint8Array(8 * 1024).fill(1)
    const chunks = Array.from({ length: Math.ceil(FAVICON_MAX_BYTES / chunk.byteLength) + 1 }, () => chunk)
    const { calls, fetch } = recordingFetcher(stubResponse({ chunks }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch })).toBe(null)
    expect(calls[0]!.signal.aborted).toBe(true)
  })

  it('accepts a chunked body exactly at the ceiling', async () => {
    const half = new Uint8Array(FAVICON_MAX_BYTES / 2).fill(7)
    const { fetch } = recordingFetcher(stubResponse({ chunks: [half, half] }))
    const result = await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch })
    expect(result?.startsWith('data:image/png;base64,')).toBe(true)
    const decoded = Buffer.from(result!.split(',')[1]!, 'base64')
    expect(decoded.byteLength).toBe(FAVICON_MAX_BYTES)
  })

  it('returns null for a non-ok status', async () => {
    const { fetch } = recordingFetcher(stubResponse({ ok: false, status: 404 }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch })).toBe(null)
  })

  it('returns null for an empty body', async () => {
    const { fetch } = recordingFetcher(stubResponse({ bytes: new Uint8Array(0) }))
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch })).toBe(null)
  })

  it('swallows a throwing fetcher instead of propagating', async () => {
    const fetch: FaviconFetcher = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await fetchFaviconDataUrl('http://localhost:9999/probe', { fetch })).toBe(null)
  })

  it('returns null when the caller signal is already aborted, without requesting', async () => {
    const { calls, fetch } = recordingFetcher(stubResponse())
    const controller = new AbortController()
    controller.abort()
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch, signal: controller.signal })).toBe(null)
    expect(calls).toHaveLength(0)
  })

  it('aborts the request when the caller signal fires mid-flight', async () => {
    const controller = new AbortController()
    const { calls, fetch } = recordingFetcher(
      () =>
        new Promise<FaviconHttpResponse>((_resolve, reject) => {
          queueMicrotask(() => {
            controller.abort()
            reject(new Error('aborted'))
          })
        }),
    )
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch, signal: controller.signal })).toBe(null)
    expect(calls[0]!.signal.aborted).toBe(true)
  })

  it('aborts and yields null when the timeout elapses', async () => {
    // Modeled on Chromium's net stack: the request stays pending until the
    // signal fires, then rejects. The timeout is what makes it fire.
    const signals: AbortSignal[] = []
    const fetch: FaviconFetcher = (_url, init) => {
      signals.push(init.signal)
      return new Promise<FaviconHttpResponse>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const started = Date.now()
    expect(await fetchFaviconDataUrl('https://example.com/favicon.ico', { fetch, timeoutMs: 20 })).toBe(null)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(signals[0]!.aborted).toBe(true)
  })
})
