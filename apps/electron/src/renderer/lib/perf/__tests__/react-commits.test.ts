import { beforeEach, describe, expect, it } from 'bun:test'

// The module reads `window` at install time; bun has no DOM, so the global has
// to exist before the module body runs — hence the dynamic import.
const fakeWindow: Record<string, unknown> = {}
;(globalThis as unknown as { window: unknown }).window = fakeWindow

const {
  installReactCommitHook,
  setCommitTrackingEnabled,
  drainCommitWindow,
  ignoreCommitContainer,
} = await import('../react-commits')

const PERFORMED_WORK = 0b1

/** Fiber tags used by the tests — see NAMED_TAGS in the module under test. */
const FUNCTION_COMPONENT = 0
const HOST_COMPONENT = 5

interface TestFiber {
  tag: number
  type: unknown
  elementType: unknown
  return: TestFiber | null
  child: TestFiber | null
  sibling: TestFiber | null
  alternate: TestFiber | null
  flags: number
  subtreeFlags: number
  memoizedProps: Record<string, unknown> | null
  memoizedState: unknown
  actualDuration?: number
}

interface Spec {
  name: string
  tag?: number
  props?: Record<string, unknown>
  state?: unknown
  /** Set when this fiber re-rendered (React's PerformedWork flag). */
  rendered?: boolean
  /** Set when anything below re-rendered. */
  subtreeRendered?: boolean
  duration?: number
  children?: Spec[]
  /** Previous-render props; omit to reuse `props` (i.e. nothing changed). */
  prevProps?: Record<string, unknown>
  prevState?: unknown
  /** Omit the alternate entirely to model a mount. */
  mounted?: boolean
}

function build(spec: Spec): TestFiber {
  const fiber: TestFiber = {
    tag: spec.tag ?? FUNCTION_COMPONENT,
    // React stores the component function itself in `fiber.type`; the object
    // wrapper shapes are only used by memo/forwardRef.
    type: { [spec.name]: () => null }[spec.name],
    elementType: null,
    return: null,
    child: null,
    sibling: null,
    alternate: null,
    flags: spec.rendered ? PERFORMED_WORK : 0,
    subtreeFlags: spec.subtreeRendered ? PERFORMED_WORK : 0,
    memoizedProps: spec.props ?? {},
    memoizedState: spec.state ?? null,
    actualDuration: spec.duration,
  }

  if (!spec.mounted) {
    fiber.alternate = {
      ...fiber,
      memoizedProps: spec.prevProps ?? spec.props ?? {},
      memoizedState: spec.prevState ?? spec.state ?? null,
      alternate: fiber,
      child: null,
      sibling: null,
    }
  }

  let previous: TestFiber | null = null
  for (const childSpec of spec.children ?? []) {
    const child = build(childSpec)
    child.return = fiber
    if (previous) previous.sibling = child
    else fiber.child = child
    previous = child
  }
  return fiber
}

function commit(root: TestFiber, containerInfo: unknown = 'app-root'): void {
  // The hook is installed by the module under test; the test knows its shape
  // because it is the same contract React calls.
  const hook = fakeWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__ as {
    onCommitFiberRoot: (id: number, root: { current: TestFiber; containerInfo: unknown }) => void
  }
  hook.onCommitFiberRoot(1, { current: root, containerInfo })
}

describe('react commit tracking', () => {
  beforeEach(() => {
    installReactCommitHook()
    setCommitTrackingEnabled(false)
    setCommitTrackingEnabled(true)
    drainCommitWindow()
  })

  it('counts every named component on mount and ignores host fibers', () => {
    commit(
      build({
        name: 'Root',
        mounted: true,
        children: [
          { name: 'div', tag: HOST_COMPONENT, mounted: true, children: [{ name: 'Leaf', mounted: true }] },
        ],
      }),
    )

    const window = drainCommitWindow()
    expect(window.commits).toBe(1)
    expect(window.components.map((c) => c.name).sort()).toEqual(['Leaf', 'Root'])
    expect(window.components.every((c) => c.renders === 1)).toBe(true)
    // Mounts have no previous props to compare, so nothing is called wasted.
    expect(window.components.every((c) => c.wasted === 0)).toBe(true)
  })

  it('skips subtrees React did not touch', () => {
    // Root re-rendered; `Quiet` bailed out entirely (no flags, no subtreeFlags),
    // so its child must never be visited even though it claims to have rendered.
    commit(
      build({
        name: 'Root',
        rendered: true,
        subtreeRendered: true,
        children: [
          { name: 'Busy', rendered: true },
          { name: 'Quiet', children: [{ name: 'HiddenChild', rendered: true }] },
        ],
      }),
    )

    const window = drainCommitWindow()
    expect(window.components.map((c) => c.name).sort()).toEqual(['Busy', 'Root'])
  })

  it('flags a render with no prop or state change as wasted', () => {
    const stableProps = { value: 1 }
    commit(
      build({
        name: 'Root',
        rendered: true,
        props: stableProps,
        prevProps: stableProps,
      }),
    )

    const [stat] = drainCommitWindow().components
    expect(stat?.name).toBe('Root')
    expect(stat?.renders).toBe(1)
    expect(stat?.wasted).toBe(1)
    expect(stat?.topProps).toEqual([])
  })

  it('names the props that actually changed', () => {
    commit(
      build({
        name: 'Panel',
        rendered: true,
        props: { id: 'a', onClick: () => {}, stable: 1 },
        prevProps: { id: 'a', onClick: () => {}, stable: 1 },
      }),
    )

    const [stat] = drainCommitWindow().components
    // `id` and `stable` are primitives that did not change; `onClick` is a new
    // function identity every render — the classic memo-defeating prop.
    expect(stat?.topProps).toEqual(['onClick'])
    expect(stat?.wasted).toBe(0)
  })

  it('reports a removed prop as a change', () => {
    commit(
      build({
        name: 'Panel',
        rendered: true,
        props: { a: 1 },
        prevProps: { a: 1, b: 2 },
      }),
    )

    expect(drainCommitWindow().components[0]?.topProps).toEqual(['b'])
  })

  it('treats a changed hook value as state, not waste', () => {
    const fiber = build({ name: 'Counter', rendered: true, props: {} })
    fiber.memoizedState = { memoizedState: 2, next: null }
    fiber.alternate!.memoizedState = { memoizedState: 1, next: null }

    commit(fiber)

    const [stat] = drainCommitWindow().components
    expect(stat?.wasted).toBe(0)
  })

  it('subtracts child time so self time is not counted once per depth level', () => {
    commit(
      build({
        name: 'Parent',
        mounted: true,
        duration: 10,
        children: [{ name: 'Child', mounted: true, duration: 7 }],
      }),
    )

    const window = drainCommitWindow()
    const parent = window.components.find((c) => c.name === 'Parent')
    const child = window.components.find((c) => c.name === 'Child')
    expect(parent?.selfMs).toBe(3)
    expect(child?.selfMs).toBe(7)
    expect(window.totalSelfMs).toBe(10)
    expect(window.durationsAvailable).toBe(true)
  })

  it('ignores registered containers so the overlay does not measure itself', () => {
    ignoreCommitContainer('overlay-root')
    commit(build({ name: 'PerfOverlay', mounted: true }), 'overlay-root')

    const window = drainCommitWindow()
    expect(window.commits).toBe(0)
    expect(window.components).toEqual([])
  })

  it('records nothing while disabled', () => {
    setCommitTrackingEnabled(false)
    commit(build({ name: 'Root', mounted: true }))

    expect(drainCommitWindow().commits).toBe(0)
  })

  it('folds components past the tracking cap into one bucket the total still reconciles with', () => {
    // 406 distinct named components (root + 405 children) exceeds the 400 cap,
    // so the tail is bucketed rather than dropped: per-component self time must
    // still sum to totalSelfMs or the report's table would not add up.
    const children: Spec[] = []
    for (let i = 0; i < 405; i++) children.push({ name: `C${i}`, mounted: true, duration: 1 })
    commit(build({ name: 'Root', mounted: true, children }))

    const window = drainCommitWindow()
    const other = window.components.find((c) => c.name === '(other)')
    expect(other).toBeDefined()
    // Cap is 400 distinct; root + 399 children fill it, leaving 6 in the bucket.
    expect(other?.renders).toBe(6)
    expect(other?.selfMs).toBe(6)
    const summed = window.components.reduce((sum, c) => sum + c.selfMs, 0)
    expect(summed).toBe(window.totalSelfMs)
    expect(window.totalSelfMs).toBe(405)
  })
})
