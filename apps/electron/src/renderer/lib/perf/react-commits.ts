/**
 * React commit tracking via the DevTools global hook.
 *
 * Answers "what re-rendered, how often, how long, and why" for the entire tree
 * without touching a single component. React reports every commit to
 * `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`; we install (or chain onto) that hook
 * before `react-dom` is evaluated and walk the fibers that actually rendered.
 *
 * Two hard constraints drive the design:
 *
 * 1. The hook MUST exist before `react-dom` runs `injectInternals`, and before
 *    the first `createRoot`. React only enables `ProfileMode` — the flag that
 *    populates `fiber.actualDuration` — when a hook was present when the root
 *    fiber was created. That is why `installReactCommitHook()` runs from the
 *    first import in `main.tsx` rather than from a React effect.
 * 2. `actualDuration` only exists in profiling-capable builds (development).
 *    In a packaged production renderer, commits are still counted but every
 *    duration reads 0 and component names are minified — the overlay reports
 *    `durationsAvailable: false` instead of showing fake numbers.
 *
 * Everything is behind `enabled`: while the overlay is off the hook body is one
 * boolean test per commit.
 */

// --- Minimal fiber shape we rely on -----------------------------------------
// React internals, deliberately narrow: only fields whose meaning has been
// stable across React 16–19 are read, and every access is optional-guarded.

interface Fiber {
  tag: number
  type: unknown
  elementType: unknown
  return: Fiber | null
  child: Fiber | null
  sibling: Fiber | null
  alternate: Fiber | null
  flags: number
  subtreeFlags: number
  memoizedProps: Record<string, unknown> | null
  memoizedState: unknown
  actualDuration?: number
}

interface FiberRoot {
  current: Fiber
  containerInfo?: unknown
}

interface DevToolsHook {
  isDisabled?: boolean
  supportsFiber?: boolean
  renderers?: Map<number, unknown>
  inject?: (renderer: unknown) => number
  onCommitFiberRoot?: (id: number, root: FiberRoot, priority?: unknown, didError?: boolean) => void
  onPostCommitFiberRoot?: (id: number, root: FiberRoot) => void
  onCommitFiberUnmount?: (id: number, fiber: Fiber) => void
  checkDCE?: (fn: unknown) => void
  setStrictMode?: (id: number, isStrict: boolean) => void
  on?: (...args: unknown[]) => void
  off?: (...args: unknown[]) => void
  sub?: (...args: unknown[]) => () => void
  emit?: (...args: unknown[]) => void
  getFiberRoots?: (id: number) => Set<FiberRoot>
}

declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook
  }
}

/** `ReactFiberFlags.PerformedWork` — set by `beginWork` on a fiber that rendered. */
const PERFORMED_WORK = 0b1

/** Fiber tags that correspond to a user-authored, nameable component. */
const NAMED_TAGS: Record<number, true> = {
  0: true, // FunctionComponent
  1: true, // ClassComponent
  11: true, // ForwardRef
  14: true, // MemoComponent
  15: true, // SimpleMemoComponent
}

/** Beyond this many distinct components in one window, the tail is folded into
 *  one `(other)` bucket rather than dropped. */
const MAX_TRACKED_COMPONENTS = 400
/** Synthetic name for the folded tail — see `statFor`. */
const OVERFLOW_BUCKET = '(other)'
/** Changed prop names kept per component, most frequent first. */
const MAX_PROP_NAMES = 4

// --- Public shapes ----------------------------------------------------------

export interface ComponentCommitStat {
  readonly name: string
  readonly renders: number
  /**
   * Renders where neither a prop nor a hook/state value changed — the render
   * came from a parent re-render or a context value. These are the ones worth
   * deleting.
   */
  readonly wasted: number
  /** Sum of self time (excluding children) across renders, in ms. */
  readonly selfMs: number
  /** Worst single self time, in ms. */
  readonly maxSelfMs: number
  /** Most frequently changed prop names, descending. */
  readonly topProps: readonly string[]
}

export interface CommitWindow {
  readonly commits: number
  readonly renderedFibers: number
  readonly visitedFibers: number
  readonly totalSelfMs: number
  /** False in packaged/production renderers, where React records no timings. */
  readonly durationsAvailable: boolean
  /** What this tracker itself cost during the window, in ms. */
  readonly trackerSelfMs: number
  readonly components: readonly ComponentCommitStat[]
}

// --- Mutable window accumulator ---------------------------------------------

interface MutableStat {
  renders: number
  wasted: number
  selfMs: number
  maxSelfMs: number
  props: Map<string, number>
}

let enabled = false
let installed = false
let anyDurationSeen = false
const ignoredContainers = new Set<unknown>()

let commits = 0
let renderedFibers = 0
let visitedFibers = 0
let totalSelfMs = 0
let trackerSelfMs = 0
const stats = new Map<string, MutableStat>()

function statFor(name: string): MutableStat {
  const existing = stats.get(name)
  if (existing) return existing
  // Past the cap the tail is folded into one bucket. `totalSelfMs` already
  // counts these fibers, so their self time MUST land somewhere or the report's
  // component table would no longer reconcile with its headline render time.
  const key = stats.size >= MAX_TRACKED_COMPONENTS ? OVERFLOW_BUCKET : name
  const bucketed = stats.get(key)
  if (bucketed) return bucketed
  const created: MutableStat = { renders: 0, wasted: 0, selfMs: 0, maxSelfMs: 0, props: new Map() }
  stats.set(key, created)
  return created
}

/**
 * Resolve a component's display name through the wrapper chain
 * (`memo(forwardRef(Foo))` and friends), which React stores as nested objects
 * rather than a single named function.
 */
function displayNameOf(fiber: Fiber): string {
  let type: unknown = fiber.type ?? fiber.elementType
  for (let depth = 0; depth < 4 && type != null; depth++) {
    if (typeof type === 'function') {
      const fn = type as { displayName?: string; name?: string }
      return fn.displayName || fn.name || 'Anonymous'
    }
    if (typeof type !== 'object') break
    const wrapper = type as { displayName?: string; render?: unknown; type?: unknown }
    if (typeof wrapper.displayName === 'string' && wrapper.displayName) return wrapper.displayName
    type = wrapper.render ?? wrapper.type
  }
  return 'Anonymous'
}

/**
 * Names of props whose identity changed since the previous render, plus whether
 * any hook/state value changed. A fiber that rendered with neither is a wasted
 * render: React re-ran it because an ancestor re-rendered or a context it reads
 * produced a new value.
 */
function diffFiber(fiber: Fiber, prev: Fiber): { changed: string[]; stateChanged: boolean } {
  const changed: string[] = []
  const nextProps = fiber.memoizedProps
  const prevProps = prev.memoizedProps
  if (nextProps !== prevProps && nextProps && prevProps) {
    for (const key in nextProps) {
      if (!Object.is(nextProps[key], prevProps[key])) changed.push(key)
    }
    // A removed prop is a change too, and it is invisible to the loop above.
    for (const key in prevProps) {
      if (!(key in nextProps)) changed.push(key)
    }
  } else if (nextProps !== prevProps) {
    changed.push('props')
  }

  // Function components: memoizedState is the hook linked list. Class
  // components: it is the state object. Both compare by identity per slot.
  let stateChanged = false
  if (fiber.tag === 1) {
    stateChanged = !Object.is(fiber.memoizedState, prev.memoizedState)
  } else {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null
    let prevHook = prev.memoizedState as { memoizedState?: unknown; next?: unknown } | null
    while (hook && prevHook) {
      if (!Object.is(hook.memoizedState, prevHook.memoizedState)) {
        stateChanged = true
        break
      }
      hook = (hook.next ?? null) as typeof hook
      prevHook = (prevHook.next ?? null) as typeof prevHook
    }
  }

  return { changed, stateChanged }
}

/**
 * Self time = this fiber's `actualDuration` minus its children's, because React
 * bubbles child durations into the parent during `completeWork`. Summing
 * `actualDuration` directly would count the whole tree once per depth level.
 */
function selfDurationOf(fiber: Fiber): number {
  const total = fiber.actualDuration
  if (typeof total !== 'number') return 0
  let childTime = 0
  for (let child = fiber.child; child !== null; child = child.sibling) {
    childTime += child.actualDuration ?? 0
  }
  return Math.max(0, total - childTime)
}

/**
 * Monotonic view of app-tree commit activity, mutated in place so the
 * interaction tracker can poll it every animation frame without allocating.
 * `seq` never resets; `at` is a `performance.now()` timestamp.
 */
export const commitClock = { seq: 0, at: 0 }

function recordCommit(root: FiberRoot): void {
  if (ignoredContainers.has(root.containerInfo)) return

  const startedAt = performance.now()
  commits++
  commitClock.seq++
  commitClock.at = startedAt

  // Iterative pre-order walk. A subtree is skipped entirely when React marked
  // neither the fiber nor its subtree as having performed work — that is the
  // difference between walking the fibers that rendered and walking the app.
  let fiber: Fiber | null = root.current
  const stack: Fiber[] = []

  while (fiber) {
    visitedFibers++
    const prev = fiber.alternate
    const rendered = prev === null || (fiber.flags & PERFORMED_WORK) !== 0

    if (rendered && NAMED_TAGS[fiber.tag]) {
      renderedFibers++
      const self = selfDurationOf(fiber)
      if (self > 0) anyDurationSeen = true
      totalSelfMs += self

      const stat = statFor(displayNameOf(fiber))
      stat.renders++
      stat.selfMs += self
      if (self > stat.maxSelfMs) stat.maxSelfMs = self
      if (prev) {
        const { changed, stateChanged } = diffFiber(fiber, prev)
        if (changed.length === 0 && !stateChanged) stat.wasted++
        for (const key of changed) stat.props.set(key, (stat.props.get(key) ?? 0) + 1)
      }
    }

    // Descend only where work happened. On mount (`prev === null`) everything
    // below rendered by definition, so the flags check is skipped.
    const child: Fiber | null = fiber.child
    const descend =
      child !== null &&
      (prev === null || (fiber.subtreeFlags & PERFORMED_WORK) !== 0 || rendered)

    if (descend) {
      if (fiber.sibling) stack.push(fiber.sibling)
      fiber = child
      continue
    }
    fiber = fiber.sibling ?? stack.pop() ?? null
  }

  trackerSelfMs += performance.now() - startedAt
}

/** Exclude a container from tracking — used for the overlay's own React root. */
export function ignoreCommitContainer(container: unknown): void {
  ignoredContainers.add(container)
}

export function setCommitTrackingEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  drainCommitWindow()
}

export function isCommitHookInstalled(): boolean {
  return installed
}

/** Snapshot and reset the accumulator. Called once per 1 Hz aggregation tick. */
export function drainCommitWindow(): CommitWindow {
  const components: ComponentCommitStat[] = []
  for (const [name, stat] of stats) {
    const topProps = [...stat.props.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PROP_NAMES)
      .map(([key]) => key)
    components.push({
      name,
      renders: stat.renders,
      wasted: stat.wasted,
      selfMs: stat.selfMs,
      maxSelfMs: stat.maxSelfMs,
      topProps,
    })
  }
  components.sort((a, b) => b.selfMs - a.selfMs || b.renders - a.renders)

  const snapshot: CommitWindow = {
    commits,
    renderedFibers,
    visitedFibers,
    totalSelfMs,
    durationsAvailable: anyDurationSeen,
    trackerSelfMs,
    components,
  }

  commits = 0
  renderedFibers = 0
  visitedFibers = 0
  totalSelfMs = 0
  trackerSelfMs = 0
  stats.clear()
  return snapshot
}

/**
 * Install (or chain onto) the DevTools hook. MUST be called before `react-dom`
 * is imported — see the module header. Safe to call twice; the second call is a
 * no-op. Returns false when the environment already refused DevTools (packaged
 * builds stub the hook with `isDisabled`).
 */
export function installReactCommitHook(): boolean {
  if (installed) return true
  if (typeof window === 'undefined') return false

  const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (existing?.isDisabled) return false

  if (existing) {
    // Real React DevTools (or another consumer) got here first. Chain so both
    // keep working — clobbering would silently break the DevTools panel.
    const previous = existing.onCommitFiberRoot
    existing.onCommitFiberRoot = (id, root, priority, didError) => {
      if (enabled) {
        try {
          recordCommit(root)
        } catch {
          // A fiber-shape change must degrade the overlay, never the app.
        }
      }
      previous?.call(existing, id, root, priority, didError)
    }
    installed = true
    return true
  }

  let nextRendererId = 1
  const renderers = new Map<number, unknown>()
  const roots = new Set<FiberRoot>()

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const id = nextRendererId++
      renderers.set(id, renderer)
      return id
    },
    onCommitFiberRoot(_id, root) {
      roots.add(root)
      if (!enabled) return
      try {
        recordCommit(root)
      } catch {
        // See above: never let an internals mismatch crash the renderer.
      }
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    getFiberRoots: () => roots,
    setStrictMode() {},
    checkDCE() {},
    on() {},
    off() {},
    sub: () => () => {},
    emit() {},
  }

  installed = true
  return true
}
