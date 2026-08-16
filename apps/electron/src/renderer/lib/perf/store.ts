/**
 * The perf monitor's aggregation loop and external store.
 *
 * Once per second it drains every collector into one immutable snapshot, keeps
 * a bounded history for sparklines and reports, and notifies subscribers. The
 * overlay reads it through `useSyncExternalStore`, so the app tree never
 * re-renders because of the monitor.
 *
 * Off by default. `setPerfEnabled(false)` disconnects every observer, stops the
 * main-process sampler over RPC, and clears history — the residual cost is one
 * boolean test per RPC call and per React commit.
 */

import type { PerfMainSample } from '@craft-agent/shared/perf'
import * as storage from '../local-storage'
import {
  drainCommitWindow,
  isCommitHookInstalled,
  setCommitTrackingEnabled,
  type CommitWindow,
} from './react-commits'
import { drainFrameWindow, startFrameCollectors, stopFrameCollectors, type FrameWindow } from './frames'
import {
  clearInteractions,
  getRecentInteractions,
  startInteractionCapture,
  stopInteractionCapture,
  type InteractionSample,
} from './interactions'
import type { RpcChannelStat } from '../../../preload/rpc-probe'

const AGGREGATION_INTERVAL_MS = 1000
/** Windows kept in memory: 5 minutes at 1 Hz. */
const MAX_HISTORY = 300
/** Windows blended into the smoothed readouts — enough to stop flicker, short
 *  enough that a regression shows up within a few seconds. */
const SMOOTHING_WINDOWS = 3

declare global {
  interface Window {
    craftPerfRpc?: {
      setEnabled(next: boolean): void
      drain(): RpcChannelStat[]
    }
  }
}

/** Readouts averaged over the last few windows to stop single-frame flicker. */
export interface SmoothedReadout {
  readonly fps: number | null
  readonly longTaskMsPerSec: number
  readonly commitsPerSec: number
  readonly renderSelfMsPerSec: number
  readonly mainCpuPercent: number | null
  readonly rendererCpuPercent: number | null
}

export interface PerfSnapshot {
  readonly enabled: boolean
  /** `Date.now()` at the close of the window. */
  readonly ts: number
  readonly windowMs: number
  /** Wall clock jumped during this window — its rates are not comparable. */
  readonly discontinuity: boolean
  readonly frames: FrameWindow
  readonly commits: CommitWindow
  readonly rpc: readonly RpcChannelStat[]
  readonly interactions: readonly InteractionSample[]
  /** Latest main-process sample, or `null` before the first push arrives. */
  readonly main: PerfMainSample | null
  readonly smoothed: SmoothedReadout
  /** False when React commit data is unavailable (packaged build, no hook). */
  readonly commitTrackingAvailable: boolean
}

const EMPTY_FRAMES: FrameWindow = {
  fps: null,
  worstFrameGapMs: 0,
  longTaskMsPerSec: 0,
  longTaskCount: 0,
  blockingMs: 0,
  worstInteractionMs: 0,
  worstInteractionName: null,
  scripts: [],
  heapUsedMb: null,
  heapLimitMb: null,
  domNodes: 0,
}

const EMPTY_COMMITS: CommitWindow = {
  commits: 0,
  renderedFibers: 0,
  visitedFibers: 0,
  totalSelfMs: 0,
  durationsAvailable: false,
  trackerSelfMs: 0,
  components: [],
}

const EMPTY_SNAPSHOT: PerfSnapshot = {
  enabled: false,
  ts: 0,
  windowMs: 0,
  discontinuity: false,
  frames: EMPTY_FRAMES,
  commits: EMPTY_COMMITS,
  rpc: [],
  interactions: [],
  main: null,
  smoothed: {
    fps: null,
    longTaskMsPerSec: 0,
    commitsPerSec: 0,
    renderSelfMsPerSec: 0,
    mainCpuPercent: null,
    rendererCpuPercent: null,
  },
  commitTrackingAvailable: false,
}

let snapshot: PerfSnapshot = EMPTY_SNAPSHOT
let history: PerfSnapshot[] = []
const listeners = new Set<() => void>()

let enabled = false
let timer: number | null = null
let windowStartedAt = 0
let latestMainSample: PerfMainSample | null = null
let unsubscribeMainSamples: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function average(values: (number | null)[]): number | null {
  let sum = 0
  let count = 0
  for (const value of values) {
    if (value === null) continue
    sum += value
    count++
  }
  return count === 0 ? null : sum / count
}

export function buildSmoothed(latest: PerfSnapshot, priorWindows: readonly PerfSnapshot[]): SmoothedReadout {
  // The current window is not in `priorWindows` yet, so include it explicitly.
  const windows = [...priorWindows.slice(-(SMOOTHING_WINDOWS - 1)), latest].filter((w) => !w.discontinuity)
  if (windows.length === 0) return latest.smoothed

  const seconds = windows.reduce((sum, w) => sum + w.windowMs, 0) / 1000 || 1
  const cpuFor = (key: 'main' | 'renderer') =>
    average(
      windows.map((w) => {
        if (!w.main) return null
        if (key === 'main') return w.main.processes.find((p) => p.key === 'main')?.cpuPercent ?? null
        // Several renderer processes can exist (browser panes); the app shell is
        // the busiest one and the only one the user is complaining about.
        const renderers = w.main.processes.filter((p) => p.key.startsWith('tab:'))
        return renderers.length === 0 ? null : Math.max(...renderers.map((p) => p.cpuPercent))
      }),
    )

  return {
    fps: average(windows.map((w) => w.frames.fps)),
    longTaskMsPerSec: windows.reduce((sum, w) => sum + w.frames.longTaskMsPerSec, 0) / windows.length,
    commitsPerSec: windows.reduce((sum, w) => sum + w.commits.commits, 0) / seconds,
    renderSelfMsPerSec: windows.reduce((sum, w) => sum + w.commits.totalSelfMs, 0) / seconds,
    mainCpuPercent: cpuFor('main'),
    rendererCpuPercent: cpuFor('renderer'),
  }
}

function aggregate(): void {
  const now = Date.now()
  const windowMs = Math.max(1, now - windowStartedAt)
  windowStartedAt = now

  const frames = drainFrameWindow(windowMs)
  const commits = drainCommitWindow()
  const rpc = window.craftPerfRpc?.drain() ?? []

  const next: PerfSnapshot = {
    enabled: true,
    ts: now,
    windowMs,
    // A window far longer than the interval means the machine slept or the
    // main thread was blocked hard enough that rates are meaningless.
    discontinuity: windowMs > AGGREGATION_INTERVAL_MS * 3,
    frames,
    commits,
    rpc: rpc.sort((a, b) => b.totalMs - a.totalMs),
    interactions: [...getRecentInteractions()],
    main: latestMainSample,
    smoothed: EMPTY_SNAPSHOT.smoothed,
    commitTrackingAvailable: isCommitHookInstalled(),
  }

  snapshot = { ...next, smoothed: buildSmoothed(next, history) }
  history.push(snapshot)
  if (history.length > MAX_HISTORY) history.shift()
  emit()
}

export function isPerfEnabled(): boolean {
  return enabled
}

export function getPerfSnapshot(): PerfSnapshot {
  return snapshot
}

export function getPerfHistory(): readonly PerfSnapshot[] {
  return history
}

export function subscribeToPerf(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setPerfEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  storage.set(storage.KEYS.perfOverlayEnabled, next)

  if (next) {
    windowStartedAt = Date.now()
    history = []
    latestMainSample = null
    setCommitTrackingEnabled(true)
    startFrameCollectors()
    startInteractionCapture()
    window.craftPerfRpc?.setEnabled(true)

    unsubscribeMainSamples = window.electronAPI.onPerfSample((sample) => {
      latestMainSample = sample
    })
    void window.electronAPI.perfSubscribe().catch(() => {
      // Headless/web adapters have no main-process sampler; renderer-side
      // metrics remain fully functional without it.
    })

    // The overlay renders nothing while `snapshot.enabled` is false, and the
    // first real window is a second away — publish an empty enabled snapshot so
    // the toggle has an immediate visible effect.
    snapshot = { ...EMPTY_SNAPSHOT, enabled: true, ts: windowStartedAt, commitTrackingAvailable: isCommitHookInstalled() }
    timer = window.setInterval(aggregate, AGGREGATION_INTERVAL_MS)
  } else {
    window.clearInterval(timer ?? undefined)
    timer = null
    unsubscribeMainSamples?.()
    unsubscribeMainSamples = null
    void window.electronAPI.perfUnsubscribe().catch(() => {})
    window.craftPerfRpc?.setEnabled(false)
    setCommitTrackingEnabled(false)
    stopFrameCollectors()
    stopInteractionCapture()
    clearInteractions()
    latestMainSample = null
    history = []
    snapshot = EMPTY_SNAPSHOT
  }

  emit()
}

/** Restore the persisted state on boot so a diagnosis survives a reload. */
export function restorePerfEnabled(): void {
  if (storage.get(storage.KEYS.perfOverlayEnabled, false)) setPerfEnabled(true)
}
