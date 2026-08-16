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
 * Membership is tested with `Object.hasOwn`, never by truthiness: the lookup
 * key is an attacker-chosen response header, and every object literal inherits
 * from `Object.prototype`, so `Content-Type: constructor` or `__proto__` would
 * otherwise resolve to something truthy and be interpolated straight into the
 * `data:` URL. The guard the rest of this module leans on has to be a closed
 * set. Same reasoning as the capability dispatch in `browser-pane-manager.ts`.
 *
 * `image/svg+xml` is deliberately absent. An SVG in a `data:` URL inside `<img>`
 * cannot run script, but it is still parsed by the privileged renderer's SVG
 * engine — a far larger parser surface than a raster decoder, selected by an
 * untrusted page. The upside is nil (sites that ship `favicon.svg` also expose
 * an ICO/PNG candidate, and we walk the whole candidate list), while the
 * downside is asymmetric: wrongly accepting means parser execution in the
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

/**
 * Hard cap on redirect hops.
 *
 * Every hop target is chosen by the server, so each one is revalidated against
 * the scheme allowlist before it is followed. The cap is what stops a redirect
 * chain from holding a partition socket for the whole timeout window; two hops
 * covers the real pattern (`/favicon.ico` -> canonical path -> CDN).
 */
export const FAVICON_MAX_REDIRECTS = 2

/**
 * Minimal response shape the transport needs.
 *
 * `body` is required: a favicon response is read with the ceiling applied per
 * chunk, and an `arrayBuffer()` fallback would buffer the whole body before
 * anyone could compare it against the ceiling.
 */
export interface FaviconHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array>
}

export type FaviconFetcher = (url: string, init: { signal: AbortSignal }) => Promise<FaviconHttpResponse>

export interface FaviconFetchOptions {
  /**
   * Bound to the pane's own session, so the proxy comes from that partition.
   * The caller pins `credentials: 'omit'` and per-hop redirect validation — see
   * `BrowserPaneManager.createFaviconFetcher`.
   */
  fetch: FaviconFetcher
  /** Fires when the instance navigates away or is destroyed. */
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Whether a redirect hop may be followed: the target passes the same scheme
 * allowlist as the URL the page announced, and the chain is still under the cap.
 *
 * Pure so the policy is unit-testable; the Electron `ClientRequest` wiring that
 * calls it lives in `browser-pane-manager.ts`.
 */
export function shouldFollowFaviconRedirect(nextUrl: string | null | undefined, hopsFollowed: number): boolean {
  if (hopsFollowed >= FAVICON_MAX_REDIRECTS) return false
  return isFetchableFaviconUrl(nextUrl)
}

/**
 * First value of a header from an Electron `IncomingMessage.headers` bag.
 *
 * `Object.hasOwn` for the same reason the content-type allowlist uses it: the
 * bag is a plain object, so a lookup of `constructor` or `toString` would
 * otherwise return an inherited function instead of `null`.
 */
export function firstHeaderValue(headers: Record<string, string | string[]>, name: string): string | null {
  const key = name.toLowerCase()
  if (!Object.hasOwn(headers, key)) return null
  const value = headers[key]
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
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
  return Object.hasOwn(ALLOWED_FAVICON_CONTENT_TYPES, type) ? type : null
}

/** `data:<type>;base64,<bytes>`, or `null` for an empty or oversized body. */
export function toFaviconDataUrl(contentType: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > FAVICON_MAX_BYTES) return null
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Best-effort teardown of a body we are dropping. Cancellation is decoration
 * cleanup: a rejected `cancel()` means the body is already gone, so nothing here
 * may throw — the transport promise never rejects on a favicon failure.
 */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Already torn down; there is nothing left to salvage.
  }
}

/** Drop an abandoned body without reading it, so it never streams into the partition. */
function cancelBody(response: FaviconHttpResponse): void {
  try {
    void response.body.cancel().catch(() => {})
  } catch {
    // A synchronously-throwing or already-locked body is still being dropped.
  }
}

/**
 * Read the body with the ceiling applied per chunk, so a `chunked` response
 * with no `content-length` is torn down as soon as it overruns instead of
 * buffering until the timeout.
 */
async function readCappedBody(response: FaviconHttpResponse, controller: AbortController): Promise<Uint8Array | null> {
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // A `200` whose body then stalls (no chunk, no `close`) would pin
  // `reader.read()` forever, hanging the sequential resolveFavicon walk and
  // holding the partition socket. Both the timeout and the byte ceiling fire
  // `controller`, so race every read against it and observe the abort here
  // rather than waiting for the transport to cooperate. Built once — one
  // listener for the whole body, not one per chunk.
  const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<null>()
  if (controller.signal.aborted) {
    resolveAborted(null)
  } else {
    controller.signal.addEventListener('abort', () => resolveAborted(null), { once: true })
  }
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next === null) {
        // Abort won the race: cancel to settle the pending read (releaseLock
        // rejects while a read is outstanding) and to drop the body.
        await cancelReader(reader)
        return null
      }
      const { done, value } = next
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > FAVICON_MAX_BYTES) {
        controller.abort()
        // Best-effort: stop the transport from streaming the rest into the
        // partition. Cancel before releaseLock.
        await cancelReader(reader)
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
    if (!response.ok) {
      cancelBody(response)
      return null
    }

    const contentType = normalizeFaviconContentType(response.headers.get('content-type'))
    if (!contentType) {
      cancelBody(response)
      return null
    }

    // A lying/absent header is not trusted either way — readCappedBody re-caps.
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > FAVICON_MAX_BYTES) {
      cancelBody(response)
      return null
    }

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
