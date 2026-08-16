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
 * interaction from the DOM, so no component needs instrumenting.
 */

import { commitClock } from './react-commits'

/** No further commits for this long ⇒ the UI has settled. */
const SETTLE_QUIET_MS = 250
/** Hard stop so a permanently churning UI cannot leak a pending interaction. */
const MAX_INTERACTION_MS = 15_000
/**
 * Largest gap between two `poll` ticks a live rAF loop can produce. A bigger
 * gap means the tab was backgrounded (rAF is throttled or paused when hidden)
 * or the machine slept: the elapsed wall time is not latency the user waited
 * through, so the interaction is discarded instead of being reported — without
 * this, a click left in a background tab surfaces as a multi-minute "latency"
 * that sorts to the top of the report.
 */
const MAX_POLL_GAP_MS = 1_000
/** Interactions retained for the overlay's recent list. */
const MAX_RECENT = 24

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

/** How the overlay/report should present interaction settle latency. */
export interface InteractionDisplay {
  /** Show the settle latency figure; false when it cannot be measured. */
  readonly showSettle: boolean
  /** Warn that settle latency is unmeasurable in this build. */
  readonly warnUnavailable: boolean
}

/**
 * Settle latency is derived entirely from React commit activity (`commitClock`),
 * which only advances while the DevTools commit hook is installed — development
 * only. In a packaged renderer every interaction reports `settledMs: 0` with 0
 * commits, so rendering that as a green number is a lie: warn and omit it
 * instead. Pure so both the overlay and the report share one decision.
 */
export function interactionDisplay(commitTrackingAvailable: boolean): InteractionDisplay {
  return { showSettle: commitTrackingAvailable, warnUnavailable: !commitTrackingAvailable }
}

interface Pending {
  label: string
  startedAt: number
  startSeq: number
  firstCommitAt: number | null
  /** `performance.now()` of the previous poll — used to spot a suspended tab. */
  lastPollAt: number
  rafHandle: number
}

let enabled = false
let pending: Pending | null = null
const recent: InteractionSample[] = []

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

/** The outcome of evaluating a pending interaction on one poll tick. */
export type PollResolution =
  | { readonly kind: 'settled'; readonly sample: InteractionSample }
  | { readonly kind: 'discarded' }

export interface PollDecision {
  /** First-commit timestamp to write back onto the pending interaction. */
  readonly firstCommitAt: number | null
  /** `null` ⇒ still pending; otherwise the interaction is resolved. */
  readonly resolution: PollResolution | null
}

/**
 * Pure settle decision for one poll tick, split out from the rAF plumbing so it
 * can be exercised deterministically. `clockSeq`/`clockAt` are `commitClock`
 * read at the tick; `now` and `pending.lastPollAt` are `performance.now()`.
 */
export function evaluatePoll(
  pending: Pick<Pending, 'label' | 'startedAt' | 'startSeq' | 'firstCommitAt' | 'lastPollAt'>,
  now: number,
  clockSeq: number,
  clockAt: number,
): PollDecision {
  const elapsed = now - pending.startedAt
  const commits = clockSeq - pending.startSeq
  const firstCommitAt =
    pending.firstCommitAt === null && commits > 0 ? clockAt : pending.firstCommitAt

  // A tick that arrives long after the last one means rAF stopped firing: the
  // tab was hidden or the machine slept. `elapsed` then spans dead wall time,
  // not interaction latency, so the sample is dropped rather than reported.
  if (now - pending.lastPollAt > MAX_POLL_GAP_MS) {
    return { firstCommitAt, resolution: { kind: 'discarded' } }
  }

  const quietFor = commits > 0 ? now - clockAt : elapsed
  const timedOut = elapsed >= MAX_INTERACTION_MS

  if (timedOut || quietFor >= SETTLE_QUIET_MS) {
    return {
      firstCommitAt,
      resolution: {
        kind: 'settled',
        sample: {
          label: pending.label,
          firstCommitMs: firstCommitAt === null ? null : firstCommitAt - pending.startedAt,
          // The quiet period is detection latency, not user-visible latency, so
          // it is subtracted: the UI actually stopped changing at the last commit.
          settledMs: timedOut ? elapsed : Math.max(0, clockAt - pending.startedAt),
          commits,
          timedOut,
        },
      },
    }
  }

  return { firstCommitAt, resolution: null }
}

function poll(): void {
  const current = pending
  if (!current) return

  const now = performance.now()
  const decision = evaluatePoll(current, now, commitClock.seq, commitClock.at)
  current.firstCommitAt = decision.firstCommitAt

  if (decision.resolution) {
    pending = null
    if (decision.resolution.kind === 'settled') finish(decision.resolution.sample)
    return
  }

  current.lastPollAt = now
  current.rafHandle = requestAnimationFrame(poll)
}

function onPointerDown(event: Event): void {
  if (!enabled) return
  // A new interaction supersedes an unsettled one: the user moved on, and
  // attributing the old span's tail to the new click would be a lie.
  if (pending) cancelAnimationFrame(pending.rafHandle)
  const startedAt = performance.now()
  pending = {
    label: labelForTarget(event.target),
    startedAt,
    startSeq: commitClock.seq,
    firstCommitAt: null,
    lastPollAt: startedAt,
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
}

export function getRecentInteractions(): readonly InteractionSample[] {
  return recent
}

export function clearInteractions(): void {
  recent.length = 0
}
