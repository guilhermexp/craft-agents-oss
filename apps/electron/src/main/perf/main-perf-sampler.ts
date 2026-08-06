/**
 * Main-process side of the runtime perf monitor.
 *
 * Samples the whole Electron process tree at 1 Hz and pushes one
 * `PerfMainSample` per window that has an overlay open. Sampling is strictly
 * opt-in and refcounted by client: with no subscribers there is no timer, no
 * histogram, and no GC observer — the idle cost is a `Map.size` check.
 *
 * The renderer measures itself (React commits, frames, RPC latency); this side
 * only reports what a renderer physically cannot see: per-process CPU, the
 * main event loop, and main-process GC/heap.
 */

import { app, webContents } from 'electron'
import { PerformanceObserver, monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { PerfMainSample, PerfProcessSample } from '@craft-agent/shared/perf'
import type { EventSink } from '@craft-agent/server-core/transport'

const SAMPLE_INTERVAL_MS = 1000
/** A window this many times longer than the interval means the clock jumped. */
const DISCONTINUITY_FACTOR = 3
/** Cap the process table so a fan-out of utility processes cannot flood the wire. */
const MAX_PROCESSES = 16

const KB_TO_MB = 1 / 1024
const BYTES_TO_MB = 1 / (1024 * 1024)
const NS_TO_MS = 1 / 1e6

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Human label for one Electron child process. Renderer (`Tab`) processes are
 * resolved to the window/view they host so "which panel is burning CPU" is
 * answerable; everything else falls back to the Chromium service name.
 */
function labelFor(metric: Electron.ProcessMetric, rendererTitles: Map<number, string>): string {
  switch (metric.type) {
    case 'Browser':
      return 'main'
    case 'GPU':
      return 'gpu'
    case 'Tab': {
      const title = rendererTitles.get(metric.pid)
      return title ? `renderer · ${title}` : 'renderer'
    }
    case 'Utility':
      return `utility · ${metric.serviceName ?? metric.name ?? 'unknown'}`
    default:
      return metric.name ?? metric.serviceName ?? metric.type
  }
}

/**
 * pid → a short description of what that renderer is showing. Uses webContents
 * rather than BrowserWindow so browser panes and webviews are distinguishable
 * from the app shell.
 */
function collectRendererTitles(): Map<number, string> {
  const titles = new Map<number, string>()
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    let pid: number
    try {
      pid = wc.getOSProcessId()
    } catch {
      continue
    }
    if (!pid) continue
    const title = wc.getTitle() || wc.getURL()
    const existing = titles.get(pid)
    // Several webContents can share a process; keep the first non-empty label
    // and mark the sharing rather than flapping between titles each sample.
    if (existing) {
      if (!existing.endsWith('(+)')) titles.set(pid, `${existing} (+)`)
      continue
    }
    titles.set(pid, title.length > 48 ? `${title.slice(0, 47)}…` : title)
  }
  return titles
}

export class MainPerfSampler {
  private readonly subscribers = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private loopDelay: IntervalHistogram | null = null
  private gcObserver: PerformanceObserver | null = null
  private gcMsInWindow = 0
  private lastCpu: NodeJS.CpuUsage | null = null
  private lastSampleAt = 0

  /**
   * @param getSink resolves the transport push function; `null` before the
   *   server is up, in which case a tick is silently skipped.
   * @param intervalMs sampling period. Injectable so tests can drive real
   *   timer behaviour without a wall-clock wait.
   */
  constructor(
    private readonly getSink: () => EventSink | null,
    private readonly intervalMs: number = SAMPLE_INTERVAL_MS,
  ) {}

  /** True while the timer is live — i.e. at least one client is subscribed. */
  isSampling(): boolean {
    return this.timer !== null
  }

  subscribe(clientId: string): void {
    this.subscribers.add(clientId)
    this.start()
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId)
    if (this.subscribers.size === 0) this.stop()
  }

  /** Called from the transport's per-client teardown so a closed window stops the timer. */
  cleanupClient(clientId: string): void {
    this.unsubscribe(clientId)
  }

  dispose(): void {
    this.subscribers.clear()
    this.stop()
  }

  private start(): void {
    if (this.timer) return

    this.lastCpu = process.cpuUsage()
    this.lastSampleAt = Date.now()
    this.gcMsInWindow = 0

    this.loopDelay = monitorEventLoopDelay({ resolution: 10 })
    this.loopDelay.enable()

    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.gcMsInWindow += entry.duration
      })
      this.gcObserver.observe({ entryTypes: ['gc'] })
    } catch {
      // GC entries are unavailable on some runtimes; report null rather than fail.
      this.gcObserver = null
    }

    // Prime getAppMetrics so the first reported window is a real 1 s delta
    // instead of "average since process start".
    app.getAppMetrics()

    this.timer = setInterval(() => this.emit(), this.intervalMs)
    this.timer.unref()
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.loopDelay?.disable()
    this.loopDelay = null
    this.gcObserver?.disconnect()
    this.gcObserver = null
    this.lastCpu = null
  }

  private emit(): void {
    const sink = this.getSink()
    if (!sink || this.subscribers.size === 0) return

    const sample = this.collect()
    for (const clientId of this.subscribers) {
      sink(RPC_NAMESPACES.perf.SAMPLE, { to: 'client', clientId }, sample)
    }
  }

  private collect(): PerfMainSample {
    const startedAt = performance.now()
    const now = Date.now()
    const windowMs = Math.max(1, now - this.lastSampleAt)
    const discontinuity = windowMs > this.intervalMs * DISCONTINUITY_FACTOR
    this.lastSampleAt = now

    // --- main-process CPU: measured directly, not Chromium's estimate --------
    const cpuNow = process.cpuUsage()
    const cpuDelta = this.lastCpu ? process.cpuUsage(this.lastCpu) : null
    this.lastCpu = cpuNow
    const mainCpuPercent = cpuDelta
      ? ((cpuDelta.user + cpuDelta.system) / 1000 / windowMs) * 100
      : 0

    // --- process table -------------------------------------------------------
    const rendererTitles = collectRendererTitles()
    const processes: PerfProcessSample[] = app.getAppMetrics().map((metric) => ({
      key: metric.type === 'Browser' ? 'main'
        : metric.type === 'GPU' ? 'gpu'
        : `${metric.type.toLowerCase()}:${metric.pid}`,
      label: labelFor(metric, rendererTitles),
      pid: metric.pid,
      cpuPercent: round(
        metric.type === 'Browser' ? mainCpuPercent : (metric.cpu?.percentCPUUsage ?? 0),
      ),
      rssMb: round(metric.memory.workingSetSize * KB_TO_MB),
    }))
    // Keep main and gpu pinned so an idle-but-alive process stays visible; the
    // rest compete on CPU. A process that vanishes from the table is dead, not
    // idle — that distinction is the point of pinning.
    processes.sort((a, b) => {
      const rank = (p: PerfProcessSample) => (p.key === 'main' ? 2 : p.key === 'gpu' ? 1 : 0)
      return rank(b) - rank(a) || b.cpuPercent - a.cpuPercent
    })

    // --- main event loop -----------------------------------------------------
    // The histogram floor is the sampling resolution itself; subtract it so an
    // idle loop reads ~0 instead of a constant 10 ms.
    const histogram = this.loopDelay
    const meanMs = histogram && Number.isFinite(histogram.mean)
      ? Math.max(0, histogram.mean * NS_TO_MS - 10)
      : 0
    const maxMs = histogram ? Math.max(0, histogram.max * NS_TO_MS - 10) : 0
    histogram?.reset()

    // --- heap / gc -----------------------------------------------------------
    const mem = process.memoryUsage()
    const gcMsPerSec = this.gcObserver ? round((this.gcMsInWindow / windowMs) * 1000, 2) : null
    this.gcMsInWindow = 0

    return {
      ts: now,
      windowMs,
      discontinuity,
      processes: processes.slice(0, MAX_PROCESSES),
      eventLoop: { meanMs: round(meanMs, 2), maxMs: round(maxMs, 2) },
      heap: {
        heapUsedMb: round(mem.heapUsed * BYTES_TO_MB),
        heapTotalMb: round(mem.heapTotal * BYTES_TO_MB),
        externalMb: round(mem.external * BYTES_TO_MB),
        rssMb: round(mem.rss * BYTES_TO_MB),
        gcMsPerSec,
      },
      selfMs: round(performance.now() - startedAt, 2),
    }
  }
}
