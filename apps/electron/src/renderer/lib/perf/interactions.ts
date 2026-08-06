/**
 * Interaction latency — the metric that matches the complaint.
 *
 * A click is timed from the input event to the moment the UI stops changing,
 * not to the first paint. Panel opening is exactly the case where those two
 * differ: the panel mounts a skeleton in one commit, then an IPC round trip
 * lands and the whole subtree commits again. Only the settled time reflects
 * what the user experiences as "slow".
 *
 * Capture is automatic: one capture-phase `pointerdown` listener labels the
 * interaction from the DOM, so no component needs instrumenting. Explicit
 * spans (`perfSpan`) exist for work that is not click-driven.
 */

import { commitClock } from './react-commits'

/** No further commits for this long ⇒ the UI has settled. */
const SETTLE_QUIET_MS = 250
/** Hard stop so a permanently churning UI cannot leak a pending interaction. */
const MAX_INTERACTION_MS = 15_000
/** Interactions retained for the overlay's recent list. */
const MAX_RECENT = 24
/** Distinct span names tracked before new ones are dropped. */
const MAX_SPANS = 128

export interface InteractionSample {
  readonly label: string
  /** Wall-clock ms from input event to the first commit that followed it. */
  readonly firstCommitMs: number | null
  /** Wall-clock ms from input event to the UI going quiet. */
  readonly settledMs: number
  /** React commits between the input event and settle. */
  readonly commits: number
  /** True when the hard timeout fired instead of the quiet period. */
  readonly timedOut: boolean
}

export interface SpanStat {
  readonly name: string
  readonly calls: number
  /** Synchronous time on the main thread, in ms. */
  readonly selfMs: number
  /** Wall time including awaited work, in ms. `0` for sync spans. */
  readonly waitMs: number
  readonly maxMs: number
}

interface MutableSpan {
  calls: number
  selfMs: number
  waitMs: number
  maxMs: number
}

interface Pending {
  label: string
  startedAt: number
  startSeq: number
  firstCommitAt: number | null
  rafHandle: number
}

let enabled = false
let pending: Pending | null = null
const recent: InteractionSample[] = []
const spans = new Map<string, MutableSpan>()

/**
 * A short, stable identity for whatever the user clicked. Prefers an explicit
 * `data-perf` hook, then the accessibility name, then visible text — in that
 * order, because the first two survive restyling and the third does not.
 */
function labelForTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return 'unknown'
  const el = target.closest('[data-perf],[data-testid],[aria-label],button,a,[role="button"],[role="tab"],[role="menuitem"]')
  if (!el) return target.tagName.toLowerCase()

  const explicit = el.getAttribute('data-perf') ?? el.getAttribute('data-testid')
  if (explicit) return explicit

  const aria = el.getAttribute('aria-label')
  if (aria) return `${el.tagName.toLowerCase()}:${aria.slice(0, 32)}`

  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
  if (text) return `${el.tagName.toLowerCase()}:${text.slice(0, 32)}`

  const role = el.getAttribute('role')
  return role ? `${el.tagName.toLowerCase()}[${role}]` : el.tagName.toLowerCase()
}

function finish(sample: InteractionSample): void {
  recent.push(sample)
  if (recent.length > MAX_RECENT) recent.shift()
}

function poll(): void {
  const current = pending
  if (!current) return

  const now = performance.now()
  const elapsed = now - current.startedAt
  const commits = commitClock.seq - current.startSeq

  if (current.firstCommitAt === null && commits > 0) {
    current.firstCommitAt = commitClock.at
  }

  const quietFor = commits > 0 ? now - commitClock.at : elapsed
  const timedOut = elapsed >= MAX_INTERACTION_MS

  if (timedOut || quietFor >= SETTLE_QUIET_MS) {
    pending = null
    finish({
      label: current.label,
      firstCommitMs: current.firstCommitAt === null ? null : current.firstCommitAt - current.startedAt,
      // The quiet period is detection latency, not user-visible latency, so it
      // is subtracted: the UI actually stopped changing at the last commit.
      settledMs: timedOut ? elapsed : Math.max(0, commitClock.at - current.startedAt),
      commits,
      timedOut,
    })
    return
  }

  current.rafHandle = requestAnimationFrame(poll)
}

function onPointerDown(event: Event): void {
  if (!enabled) return
  // A new interaction supersedes an unsettled one: the user moved on, and
  // attributing the old span's tail to the new click would be a lie.
  if (pending) cancelAnimationFrame(pending.rafHandle)
  pending = {
    label: labelForTarget(event.target),
    startedAt: performance.now(),
    startSeq: commitClock.seq,
    firstCommitAt: null,
    rafHandle: requestAnimationFrame(poll),
  }
}

export function startInteractionCapture(): void {
  if (enabled) return
  enabled = true
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
}

export function stopInteractionCapture(): void {
  if (!enabled) return
  enabled = false
  window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  if (pending) cancelAnimationFrame(pending.rafHandle)
  pending = null
  recent.length = 0
  spans.clear()
}

export function getRecentInteractions(): readonly InteractionSample[] {
  return recent
}

export function clearInteractions(): void {
  recent.length = 0
}

function bucketFor(name: string): MutableSpan | null {
  const existing = spans.get(name)
  if (existing) return existing
  if (spans.size >= MAX_SPANS) return null
  const created: MutableSpan = { calls: 0, selfMs: 0, waitMs: 0, maxMs: 0 }
  spans.set(name, created)
  return created
}

/**
 * Time a synchronous block. Self time and wall time are the same here, which is
 * exactly why sync work is what shows up as jank.
 */
export function perfSpan<T>(name: string, fn: () => T): T {
  if (!enabled) return fn()
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    const elapsed = performance.now() - startedAt
    const bucket = bucketFor(name)
    if (bucket) {
      bucket.calls++
      bucket.selfMs += elapsed
      if (elapsed > bucket.maxMs) bucket.maxMs = elapsed
    }
  }
}

/**
 * Time an async operation. Wall time is recorded separately from self time so a
 * span that only waits on IO never competes with one that burns the main
 * thread — ranking them together would bury the real CPU cost.
 */
export async function perfSpanAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn()
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    const elapsed = performance.now() - startedAt
    const bucket = bucketFor(name)
    if (bucket) {
      bucket.calls++
      bucket.waitMs += elapsed
      if (elapsed > bucket.maxMs) bucket.maxMs = elapsed
    }
  }
}

/** Snapshot and reset the span table. */
export function drainSpans(): SpanStat[] {
  const out: SpanStat[] = []
  for (const [name, value] of spans) {
    out.push({ name, calls: value.calls, selfMs: value.selfMs, waitMs: value.waitMs, maxMs: value.maxMs })
  }
  spans.clear()
  return out.sort((a, b) => b.selfMs - a.selfMs || b.waitMs - a.waitMs)
}
