import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import {
  openOfficeLiveServer,
  closeOfficeLiveServer,
  shutdownOfficeLiveServers,
  listOfficeLiveServers,
  __setOfficeLiveRuntimeForTests,
  __resetOfficeLiveRuntimeForTests,
} from './office-live'

afterEach(() => {
  shutdownOfficeLiveServers()
  __resetOfficeLiveRuntimeForTests()
})

describe('openOfficeLiveServer', () => {
  it('refuses file types the binary cannot serve, before spawning anything', async () => {
    for (const path of ['/tmp/notes.txt', '/tmp/data.csv', '/tmp/legacy.xls', '/tmp/macro.xlsm']) {
      await expect(openOfficeLiveServer(path)).rejects.toThrow(/Not a live-editable Office document/)
    }
  })

  it('starts with no servers running', () => {
    expect(listOfficeLiveServers()).toEqual([])
  })
})

describe('closeOfficeLiveServer', () => {
  it('is a no-op for a file with no server', () => {
    // Panel teardown fires on every file change, including ones that never
    // opened a server — it must not throw.
    expect(() => closeOfficeLiveServer('/tmp/never-opened.xlsx')).not.toThrow()
  })
})

describe('shutdownOfficeLiveServers', () => {
  it('is safe to call when nothing is running', () => {
    expect(() => shutdownOfficeLiveServers()).not.toThrow()
    expect(listOfficeLiveServers()).toEqual([])
  })
})

/**
 * A fake `officecli watch` child. The real one is a spawned process with a
 * loopback listener; these tests exercise the lifecycle (reuse, restart,
 * eviction, concurrency, readiness) through the injectable runtime seam so no
 * process is launched and no port is bound.
 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = false
  stderr: EventEmitter = new EventEmitter()
  killCount = 0
  kill(): boolean {
    this.killed = true
    this.killCount += 1
    return true
  }
}

const asChild = (child: FakeChild): ChildProcess => child as unknown as ChildProcess

describe('openOfficeLiveServer lifecycle', () => {
  let spawned: FakeChild[]
  let clock: number

  /** Install a runtime whose spawn/port/readiness the test fully controls. */
  const installRuntime = (overrides: {
    onSpawn?: (child: FakeChild) => void
    confirmOurServer?: (port: number) => Promise<boolean>
  } = {}) => {
    __setOfficeLiveRuntimeForTests({
      spawnWatch: () => {
        const child = new FakeChild()
        spawned.push(child)
        overrides.onSpawn?.(child)
        return asChild(child)
      },
      isPortFree: async () => true,
      confirmOurServer: overrides.confirmOurServer ?? (async () => true),
      // Monotonic clock so LRU ordering is deterministic instead of racing
      // Date.now() collisions within a millisecond.
      now: () => (clock += 1),
    })
  }

  beforeEach(() => {
    // Any existing file makes resolveOfficeCliPath return non-null; the value is
    // irrelevant because spawnWatch is faked.
    process.env.CRAFT_OFFICECLI = process.execPath
    spawned = []
    clock = 0
    installRuntime()
  })

  afterEach(() => {
    delete process.env.CRAFT_OFFICECLI
  })

  it('reuses a live server across opens instead of spawning a second one', async () => {
    const first = await openOfficeLiveServer('/tmp/book.xlsx')
    const second = await openOfficeLiveServer('/tmp/book.xlsx')
    expect(second).toBe(first)
    expect(spawned).toHaveLength(1)
    expect(listOfficeLiveServers()).toHaveLength(1)
  })

  it('restarts a stale entry whose child has exited rather than handing back a dead URL', async () => {
    await openOfficeLiveServer('/tmp/book.xlsx')
    expect(spawned).toHaveLength(1)

    // The child crashed but no `exit` event reached us (e.g. we missed it):
    // the next open must not reuse the dead entry.
    spawned[0].exitCode = 1

    await openOfficeLiveServer('/tmp/book.xlsx')
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe(true)
    expect(listOfficeLiveServers()).toHaveLength(1)
  })

  it('evicts the least-recently-opened server past the concurrency cap', async () => {
    // MAX_LIVE_SERVERS is 4; the fifth open must evict the oldest ('a').
    for (const path of ['/tmp/a.xlsx', '/tmp/b.xlsx', '/tmp/c.xlsx', '/tmp/d.xlsx']) {
      await openOfficeLiveServer(path)
    }
    expect(listOfficeLiveServers()).toHaveLength(4)

    await openOfficeLiveServer('/tmp/e.xlsx')

    const paths = listOfficeLiveServers().map((s) => s.filePath)
    expect(listOfficeLiveServers()).toHaveLength(4)
    expect(paths).not.toContain('/tmp/a.xlsx')
    expect(paths).toContain('/tmp/e.xlsx')
    // The evicted server's child is killed, not merely dropped from the map.
    expect(spawned[0].killed).toBe(true)
  })

  it('coalesces two concurrent opens for the same file into a single spawn', async () => {
    const [first, second] = await Promise.all([
      openOfficeLiveServer('/tmp/book.xlsx'),
      openOfficeLiveServer('/tmp/book.xlsx'),
    ])
    expect(first).toBe(second)
    // Without the in-flight guard both opens miss the map, pick the same port
    // and spawn — orphaning one child outside every teardown path.
    expect(spawned).toHaveLength(1)
    expect(listOfficeLiveServers()).toHaveLength(1)
  })

  it('makes an open that arrives mid-startup wait instead of handing back a port that is not listening', async () => {
    const gate = Promise.withResolvers<boolean>()
    let confirmCalls = 0
    installRuntime({
      confirmOurServer: async () => {
        confirmCalls += 1
        return gate.promise
      },
    })
    // Drains pending microtasks without a real timer, so "has it settled yet?"
    // is a deterministic question rather than a race against the clock.
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) await Promise.resolve()
    }

    const firstOpen = openOfficeLiveServer('/tmp/book.xlsx')
    await flush()
    // The server is registered before it answers, so teardown can reach a
    // starting child — which is exactly why the map entry must not be treated
    // as reusable yet.
    expect(confirmCalls).toBeGreaterThan(0)
    expect(listOfficeLiveServers()).toHaveLength(1)

    let secondSettled = false
    const secondOpen = openOfficeLiveServer('/tmp/book.xlsx').then((url) => {
      secondSettled = true
      return url
    })
    await flush()
    expect(secondSettled).toBe(false)

    gate.resolve(true)
    const [first, second] = await Promise.all([firstOpen, secondOpen])
    expect(second).toBe(first)
    expect(spawned).toHaveLength(1)
  })

  it('rejects without an uncaught exception when the spawned child emits error', async () => {
    installRuntime({
      // A binary that exists but cannot exec (missing +x, ENOENT) emits 'error'
      // with no 'exit'. Unlistened, that crashes the main process.
      // queueMicrotask (not a timer) so the emit lands after awaitServerReady
      // has synchronously attached its 'error' listener, deterministically.
      onSpawn: (child) => queueMicrotask(() => child.emit('error', new Error('spawn EACCES'))),
      confirmOurServer: async () => false,
    })
    await expect(openOfficeLiveServer('/tmp/book.xlsx')).rejects.toThrow(/failed to launch/)
    expect(listOfficeLiveServers()).toHaveLength(0)
  })

  it('rejects fast when the child exits during the readiness poll', async () => {
    installRuntime({
      onSpawn: (child) => queueMicrotask(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      }),
      // Never becomes ready: without racing exit, this would burn the full
      // startup timeout instead of failing immediately.
      confirmOurServer: async () => false,
    })
    await expect(openOfficeLiveServer('/tmp/book.xlsx')).rejects.toThrow(/exited during startup/)
    expect(listOfficeLiveServers()).toHaveLength(0)
  })

  it('kills the child process when the server is closed', async () => {
    await openOfficeLiveServer('/tmp/book.xlsx')
    expect(spawned[0].killed).toBe(false)

    closeOfficeLiveServer('/tmp/book.xlsx')
    expect(spawned[0].killed).toBe(true)
    expect(listOfficeLiveServers()).toHaveLength(0)
  })
})
