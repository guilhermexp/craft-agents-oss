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
import { resolveOfficeCliPath, isOfficeRenderableFile, OfficeCliUnavailableError } from './office-render'

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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
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
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortFree(port))) return true
    await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS))
  }
  return false
}

async function findFreePort(): Promise<number> {
  const taken = new Set([...servers.values()].map((s) => s.port))
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
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
  if (!isOfficeRenderableFile(filePath)) {
    throw new Error(`Not a live-editable Office document: ${filePath}`)
  }

  const existing = servers.get(filePath)
  if (existing) {
    // A crashed child leaves a stale entry; restart rather than hand back a
    // URL that no longer answers.
    if (existing.process.exitCode === null && !existing.process.killed) {
      existing.lastUsedAt = Date.now()
      return existing.url
    }
    stopServer(existing)
  }

  const officeCliPath = resolveOfficeCliPath()
  if (!officeCliPath) throw new OfficeCliUnavailableError()

  evictIfNeeded()

  const port = await findFreePort()
  const child = spawn(officeCliPath, ['watch', filePath, '--port', String(port)], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Detached would survive our exit; keep it in our process group so a hard
    // app kill takes the server with it.
    detached: false,
  })

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
    lastUsedAt: Date.now(),
  }
  servers.set(filePath, server)

  child.once('exit', () => {
    // Only forget it if this exact process is still the registered one.
    if (servers.get(filePath) === server) servers.delete(filePath)
  })

  const ready = await waitForPort(port, STARTUP_TIMEOUT_MS)
  if (!ready) {
    stopServer(server)
    throw new Error(
      `Live document server did not start within ${STARTUP_TIMEOUT_MS / 1000}s` +
      (stderr.trim() ? `: ${stderr.trim()}` : '')
    )
  }

  return server.url
}
