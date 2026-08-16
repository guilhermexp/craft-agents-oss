/**
 * Live, editable Office documents backed by `officecli watch`.
 *
 * `watch` serves the document over loopback HTTP with the binary's own editor:
 * double-click a cell, type, Enter — and it writes straight back to the .xlsx
 * with formulas recalculated by OfficeCLI's engine.
 *
 * This is why the panel embeds a URL instead of rendering HTML into a sandboxed
 * srcdoc: an srcdoc frame can display the document, but the editing UI and the
 * formula engine only exist inside the served page.
 *
 * Each watched file gets one process, reused across opens. Processes are killed
 * when the app exits — see shutdownOfficeLiveServers().
 */

import { spawn, type ChildProcess } from 'child_process'
import { createConnection } from 'net'
import { get as httpGet } from 'http'
import { resolveOfficeCliPath, isOfficeDocumentFile, OfficeCliUnavailableError } from './office-cli'

/**
 * Loopback port range for watch servers. Above OfficeCLI's own default (26315)
 * so a manually started `officecli watch` doesn't collide with ours.
 */
const PORT_RANGE_START = 26400
const PORT_RANGE_END = 26499

/** How long to wait for a freshly spawned server to accept connections. */
const STARTUP_TIMEOUT_MS = 20_000
const STARTUP_POLL_INTERVAL_MS = 150

/**
 * Cap on concurrent watch processes. Each holds a document in memory and an
 * open port, so an unbounded map would leak both as the user browses files.
 */
const MAX_LIVE_SERVERS = 4

interface LiveServer {
  filePath: string
  port: number
  process: ChildProcess
  url: string
  /** Insertion/refresh time, for evicting the least recently opened. */
  lastUsedAt: number
}

const servers = new Map<string, LiveServer>()

/**
 * In-flight opens keyed by file path, set synchronously before the first await
 * in openOfficeLiveServer. Two overlapping opens for the same document would
 * otherwise both miss `servers`, both pick the same free port, and both spawn;
 * the loser is overwritten in `servers` and its identity-guarded exit handler
 * correctly refuses to delete a foreign entry, so close/shutdown/before-quit
 * never reach it and (detached: false notwithstanding) a normal quit leaves it
 * holding a port. Coalescing onto one promise keeps it to a single spawn.
 */
const pending = new Map<string, Promise<string>>()

function isPortFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = createConnection({ port, host: '127.0.0.1' })
  const done = (free: boolean) => {
    socket.removeAllListeners()
    socket.destroy()
    resolve(free)
  }
  // A refused connection means nothing is listening — the port is ours.
  socket.once('error', () => done(true))
  socket.once('connect', () => done(false))
  socket.setTimeout(500, () => done(true))
  return promise
}

/**
 * Proof that the listener on `port` is our officecli watch child, not an
 * unrelated local process that grabbed the port between findFreePort and the
 * child's bind (those two steps are not atomic). `watch` offers no launch token
 * and no identifying header — only --port — so the strongest signal available
 * is that /events answers as a Server-Sent-Events stream, which its live-preview
 * server always does and a stray listener almost never would. Without this the
 * renderer could frame a foreign localhost page, which the CSP permits via
 * frame-src http://127.0.0.1:*.
 */
function confirmOurServer(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const req = httpGet({ host: '127.0.0.1', port, path: '/events', timeout: 500 }, (res) => {
    const contentType = res.headers['content-type'] ?? ''
    res.destroy()
    resolve(contentType.includes('text/event-stream'))
  })
  req.once('error', () => resolve(false))
  req.once('timeout', () => {
    req.destroy()
    resolve(false)
  })
  return promise
}

/**
 * Process/network dependencies, injectable so lifecycle tests can drive spawn,
 * port selection and readiness without binding real ports or launching the real
 * binary. Production always uses `defaultRuntime`.
 */
interface OfficeLiveRuntime {
  spawnWatch: (officeCliPath: string, filePath: string, port: number) => ChildProcess
  isPortFree: (port: number) => Promise<boolean>
  confirmOurServer: (port: number) => Promise<boolean>
  now: () => number
}

const defaultRuntime: OfficeLiveRuntime = {
  spawnWatch: (officeCliPath, filePath, port) =>
    spawn(officeCliPath, ['watch', filePath, '--port', String(port)], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Detached would survive our exit; keep it in our process group so a hard
      // app kill takes the server with it.
      detached: false,
    }),
  isPortFree,
  confirmOurServer,
  now: Date.now,
}

let runtime: OfficeLiveRuntime = defaultRuntime

/** Test seam: override the process/network dependencies. Not used in production. */
export function __setOfficeLiveRuntimeForTests(overrides: Partial<OfficeLiveRuntime>): void {
  runtime = { ...defaultRuntime, ...overrides }
}

/** Test seam: restore the real process/network dependencies. */
export function __resetOfficeLiveRuntimeForTests(): void {
  runtime = defaultRuntime
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function findFreePort(): Promise<number> {
  const taken = new Set([...servers.values()].map((s) => s.port))
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (taken.has(port)) continue
    if (await runtime.isPortFree(port)) return port
  }
  throw new Error('No free port available for the live document server')
}

function stopServer(server: LiveServer): void {
  servers.delete(server.filePath)
  try {
    server.process.kill()
  } catch {
    // Already gone — nothing to clean up.
  }
}

/** Stop the live server for one file, if any. */
export function closeOfficeLiveServer(filePath: string): void {
  const server = servers.get(filePath)
  if (server) stopServer(server)
}

/** Stop every live server. Call on app shutdown so no process is orphaned. */
export function shutdownOfficeLiveServers(): void {
  for (const server of [...servers.values()]) stopServer(server)
}

/** Currently running servers — for diagnostics and tests. */
export function listOfficeLiveServers(): { filePath: string; url: string }[] {
  return [...servers.values()].map(({ filePath, url }) => ({ filePath, url }))
}

function evictIfNeeded(): void {
  while (servers.size >= MAX_LIVE_SERVERS) {
    let oldest: LiveServer | null = null
    for (const server of servers.values()) {
      if (!oldest || server.lastUsedAt < oldest.lastUsedAt) oldest = server
    }
    if (!oldest) break
    stopServer(oldest)
  }
}

/**
 * Start (or reuse) a live server for a document and return its loopback URL.
 *
 * @param filePath Absolute path to an already-validated .xlsx/.docx/.pptx file.
 */
export async function openOfficeLiveServer(filePath: string): Promise<string> {
  if (!isOfficeDocumentFile(filePath)) {
    throw new Error(`Not a live-editable Office document: ${filePath}`)
  }

  // Order matters, and both checks are synchronous so no concurrent open can
  // slip between them. `pending` comes first because a LiveServer is registered
  // *before* its child answers (so teardown can reach a starting child): the
  // map entry alone would hand a second caller a URL whose port is not yet
  // listening, and the renderer would frame a dead port.
  const inFlight = pending.get(filePath)
  if (inFlight) return inFlight

  const existing = servers.get(filePath)
  if (existing && existing.process.exitCode === null && !existing.process.killed) {
    existing.lastUsedAt = runtime.now()
    return existing.url
  }

  const promise = startLiveServer(filePath)
  pending.set(filePath, promise)
  try {
    return await promise
  } finally {
    pending.delete(filePath)
  }
}

async function startLiveServer(filePath: string): Promise<string> {
  // A crashed child leaves a stale entry; restart rather than hand back a URL
  // that no longer answers.
  const stale = servers.get(filePath)
  if (stale) stopServer(stale)

  const officeCliPath = resolveOfficeCliPath()
  if (!officeCliPath) throw new OfficeCliUnavailableError()

  evictIfNeeded()

  const port = await findFreePort()
  const child = runtime.spawnWatch(officeCliPath, filePath, port)

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    // Bounded: a long-running server shouldn't accumulate output forever.
    stderr = (stderr + chunk.toString()).slice(-4096)
  })

  const server: LiveServer = {
    filePath,
    port,
    process: child,
    url: `http://127.0.0.1:${port}`,
    lastUsedAt: runtime.now(),
  }
  // Register before awaiting readiness so findFreePort's `taken` set already
  // excludes this port for a concurrent open, and every teardown path can reach
  // this child while it is still starting.
  servers.set(filePath, server)

  child.once('exit', () => {
    // Only forget it if this exact process is still the registered one.
    if (servers.get(filePath) === server) servers.delete(filePath)
  })

  try {
    await awaitServerReady(child, server.port, () => stderr.trim())
  } catch (error) {
    stopServer(server)
    throw error
  }

  return server.url
}

/**
 * Resolve once the child owns its port, reject the instant it dies or fails to
 * exec. Racing readiness against the child's own 'error'/'exit' means a binary
 * that can't launch (missing +x from an interrupted provision, ENOENT) surfaces
 * as a rejection instead of an uncaught exception in the main process, and a
 * child that dies at startup fails fast instead of burning the whole timeout.
 */
function awaitServerReady(
  child: ChildProcess,
  port: number,
  stderrTail: () => string,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  const suffix = () => (stderrTail() ? `: ${stderrTail()}` : '')

  function cleanup() {
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
  }
  function settle(act: () => void) {
    if (settled) return
    settled = true
    cleanup()
    act()
  }
  function onExit() {
    settle(() => reject(new Error(`Live document server exited during startup${suffix()}`)))
  }
  function onError(err: Error) {
    settle(() => reject(new Error(`Live document server failed to launch: ${err.message}${suffix()}`)))
  }

  child.once('exit', onExit)
  child.once('error', onError)

  const deadline = runtime.now() + STARTUP_TIMEOUT_MS
  const poll = async () => {
    while (!settled) {
      if (await runtime.confirmOurServer(port)) {
        settle(resolve)
        return
      }
      if (runtime.now() >= deadline) {
        settle(() => reject(new Error(
          `Live document server did not start within ${STARTUP_TIMEOUT_MS / 1000}s${suffix()}`,
        )))
        return
      }
      await delay(STARTUP_POLL_INTERVAL_MS)
    }
  }
  void poll()

  return promise
}
