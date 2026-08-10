/**
 * Favicon transport for the agentic browser pane.
 *
 * SECURITY: `page-favicon-updated` hands us a URL chosen by the *page*. Passing
 * that URL straight to the privileged renderer as `<img src>` turns every site
 * opened in a pane into a request emitter inside the app's own origin: a
 * hostile page points the favicon at `http://localhost:9999/...` and the
 * renderer probes local ports for it — the vector closed by
 * `openspec/changes/archive/2026-07-15-harden-navigation-and-ssrf/` — or at an
 * arbitrary https endpoint and gets beaconing for free. The renderer CSP
 * (`img-src 'self' data: https: file: thumbnail:`) blocks the http case only by
 * accident, and relaxing it to unblock local dev servers would legalize the
 * probe.
 *
 * So the main process does the fetch instead, in the pane's own session, and
 * the renderer only ever sees a validated `data:` URL — already permitted by
 * the CSP, which stays untouched.
 *
 * This module is the pure/injectable half: no Electron import, the fetcher is a
 * parameter, and nothing here throws. `BrowserPaneManager` owns the wiring and
 * the per-instance lifecycle (abort on navigate/destroy, stale-result drop).
 */

/**
 * Hard ceiling on favicon bytes.
 *
 * Real favicons run 1 KB (32x32 PNG) to ~25 KB (multi-resolution ICO). The
 * ceiling is not only about memory: the resulting `data:` URL rides along in
 * *every* `emitStateChange` for the instance (title, loading, navigation), so
 * each byte is amplified ~1.37x by base64 and repeated per state push. 32 KiB
 * covers the real world and caps that push at ~44 KB. Anything larger loses its
 * icon and falls back to the generic one — an acceptable trade for decoration.
 */
export const FAVICON_MAX_BYTES = 32 * 1024

/** A favicon is decoration; no page gets to hold a partition socket longer. */
export const FAVICON_FETCH_TIMEOUT_MS = 4_000

/**
 * Raster-only allowlist.
 *
 * `image/svg+xml` is deliberately absent. An SVG in a `data:` URL inside `<img>`
 * cannot run script, but it is still parsed by the privileged renderer's SVG
 * engine — a far larger parser surface than a raster decoder, selected by an
 * untrusted page. The upside is nil (sites that ship `favicon.svg` also expose
 * an ICO/PNG candidate, and Electron hands us the whole candidate list), while
 * the downside is asymmetric: wrongly accepting means parser execution in the
 * privileged process, wrongly rejecting means a generic icon.
 */
export const ALLOWED_FAVICON_CONTENT_TYPES: Readonly<Record<string, true>> = {
  'image/png': true,
  'image/x-icon': true,
  'image/vnd.microsoft.icon': true,
  'image/gif': true,
  'image/jpeg': true,
  'image/webp': true,
}

/** Minimal response shape shared by `session.fetch` and the test stubs. */
export interface FaviconHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FaviconFetcher = (url: string, init: { signal: AbortSignal }) => Promise<FaviconHttpResponse>

export interface FaviconFetchOptions {
  /** Bound to the pane's own session so cookies/proxy come from that partition. */
  fetch: FaviconFetcher
  /** Fires when the instance navigates away or is destroyed. */
  signal?: AbortSignal
  timeoutMs?: number
}

/** True when `raw` is a favicon URL the main process is willing to request. */
export function isFetchableFaviconUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** Allowlisted media type without parameters, or `null` when not an accepted image. */
export function normalizeFaviconContentType(raw: string | null | undefined): string | null {
  if (!raw) return null
  const type = raw.split(';')[0].trim().toLowerCase()
  return ALLOWED_FAVICON_CONTENT_TYPES[type] ? type : null
}

/** `data:<type>;base64,<bytes>`, or `null` for an empty or oversized body. */
export function toFaviconDataUrl(contentType: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > FAVICON_MAX_BYTES) return null
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Read the body with the ceiling applied per chunk, so a `chunked` response
 * with no `content-length` is torn down as soon as it overruns instead of
 * buffering until the timeout.
 */
async function readCappedBody(response: FaviconHttpResponse, controller: AbortController): Promise<Uint8Array | null> {
  const body = response.body
  if (!body) {
    const buffer = await response.arrayBuffer()
    return buffer.byteLength > FAVICON_MAX_BYTES ? null : new Uint8Array(buffer)
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > FAVICON_MAX_BYTES) {
        controller.abort()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Fetch `rawUrl` and return a validated `data:` URL, or `null`.
 *
 * Every guard failure — scheme, status, content-type, size, timeout, abort,
 * transport error — collapses to `null` silently. A favicon must never take the
 * instance down, and must never log once per navigation.
 */
export async function fetchFaviconDataUrl(rawUrl: string, options: FaviconFetchOptions): Promise<string | null> {
  if (!isFetchableFaviconUrl(rawUrl)) return null
  const external = options.signal
  if (external?.aborted) return null

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  external?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? FAVICON_FETCH_TIMEOUT_MS)

  try {
    const response = await options.fetch(rawUrl, { signal: controller.signal })
    if (!response.ok) return null

    const contentType = normalizeFaviconContentType(response.headers.get('content-type'))
    if (!contentType) return null

    // A lying/absent header is not trusted either way — readCappedBody re-caps.
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > FAVICON_MAX_BYTES) return null

    const bytes = await readCappedBody(response, controller)
    if (!bytes) return null

    return toFaviconDataUrl(contentType, bytes)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abort)
  }
}
