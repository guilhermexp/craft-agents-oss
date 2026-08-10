import { describe, expect, it, mock } from 'bun:test'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { PerfMainSample } from '@craft-agent/shared/perf'
import type { PushTarget } from '@craft-agent/shared/protocol'

mock.module('electron', () => ({
  app: {
    getAppMetrics: () => [
      { pid: 20, type: 'Tab', cpu: { percentCPUUsage: 42.5 }, memory: { workingSetSize: 512_000 } },
      { pid: 10, type: 'Browser', cpu: { percentCPUUsage: 99 }, memory: { workingSetSize: 102_400 } },
      { pid: 30, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 51_200 } },
      {
        pid: 40,
        type: 'Utility',
        serviceName: 'network.mojom.NetworkService',
        cpu: { percentCPUUsage: 3 },
        memory: { workingSetSize: 20_480 },
      },
    ],
  },
  webContents: {
    getAllWebContents: () => [
      { isDestroyed: () => false, getOSProcessId: () => 20, getTitle: () => 'Craft', getURL: () => '' },
    ],
  },
}))

// Dynamic import: mock.module('electron') must be registered before the module
// under test resolves its electron bindings.
const { MainPerfSampler } = await import('../main-perf-sampler')

/** Short enough that the suite awaits the sampler's own signal, not a clock. */
const TEST_INTERVAL_MS = 5

interface Push {
  channel: string
  target: PushTarget
  sample: PerfMainSample
}

/**
 * Collects pushes and hands back a promise per expected count, so tests await
 * the sampler emitting rather than guessing how long a window takes.
 */
function createSink() {
  const pushes: Push[] = []
  const waiters: { count: number; resolve: () => void }[] = []

  const sink = (channel: string, target: PushTarget, ...args: unknown[]): void => {
    const [sample] = args
    pushes.push({ channel, target, sample: sample as PerfMainSample })
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (pushes.length >= waiters[i]!.count) waiters.splice(i, 1)[0]!.resolve()
    }
  }

  const waitFor = (count: number): Promise<void> => {
    if (pushes.length >= count) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    waiters.push({ count, resolve })
    return promise
  }

  return { pushes, sink, waitFor }
}

describe('MainPerfSampler', () => {
  it('pushes one sample per subscribed client', async () => {
    const { pushes, sink, waitFor } = createSink()
    const sampler = new MainPerfSampler(() => sink, TEST_INTERVAL_MS)

    sampler.subscribe('client-a')
    sampler.subscribe('client-b')
    await waitFor(2)
    sampler.dispose()

    expect(pushes.every((p) => p.channel === RPC_NAMESPACES.perf.SAMPLE)).toBe(true)
    expect(pushes.map((p) => p.target)).toContainEqual({ to: 'client', clientId: 'client-a' })
    expect(pushes.map((p) => p.target)).toContainEqual({ to: 'client', clientId: 'client-b' })
  })

  it('runs no timer until subscribed and stops on the last unsubscribe', async () => {
    const { sink, waitFor } = createSink()
    const sampler = new MainPerfSampler(() => sink, TEST_INTERVAL_MS)

    expect(sampler.isSampling()).toBe(false)

    sampler.subscribe('client-a')
    sampler.subscribe('client-b')
    await waitFor(1)
    expect(sampler.isSampling()).toBe(true)

    sampler.unsubscribe('client-a')
    expect(sampler.isSampling()).toBe(true)

    sampler.unsubscribe('client-b')
    expect(sampler.isSampling()).toBe(false)
  })

  it('labels processes and pins main and gpu ahead of hotter children', async () => {
    const { pushes, sink, waitFor } = createSink()
    const sampler = new MainPerfSampler(() => sink, TEST_INTERVAL_MS)

    sampler.subscribe('client')
    await waitFor(1)
    sampler.dispose()

    const sample = pushes[0]!.sample
    // The Tab burns the most CPU, but main and gpu stay pinned: a process
    // disappearing from the table must mean it died, not that it went idle.
    expect(sample.processes.map((p) => p.key).slice(0, 2)).toEqual(['main', 'gpu'])
    expect(sample.processes.find((p) => p.pid === 20)?.label).toBe('renderer · Craft')
    expect(sample.processes.find((p) => p.pid === 40)?.label).toBe('utility · network.mojom.NetworkService')
    expect(sample.processes.find((p) => p.pid === 20)?.rssMb).toBe(500)
  })

  it('measures main CPU itself instead of trusting Chromium', async () => {
    const { pushes, sink, waitFor } = createSink()
    const sampler = new MainPerfSampler(() => sink, TEST_INTERVAL_MS)

    sampler.subscribe('client')
    await waitFor(1)
    sampler.dispose()

    // getAppMetrics claims 99% for the Browser process. The sampler must report
    // its own process.cpuUsage() delta there and leave every other process on
    // Chromium's number.
    const sample = pushes[0]!.sample
    expect(sample.processes.find((p) => p.key === 'main')!.cpuPercent).not.toBe(99)
    expect(sample.processes.find((p) => p.key === 'main')!.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(sample.processes.find((p) => p.pid === 20)!.cpuPercent).toBe(42.5)
    expect(sample.processes.find((p) => p.key === 'gpu')!.cpuPercent).toBe(1)
  })

  it('reports the real window length, heap and its own cost', async () => {
    const { pushes, sink, waitFor } = createSink()
    const sampler = new MainPerfSampler(() => sink, TEST_INTERVAL_MS)

    sampler.subscribe('client')
    await waitFor(1)
    sampler.dispose()

    const sample = pushes[0]!.sample
    expect(sample.windowMs).toBeGreaterThan(0)
    expect(sample.discontinuity).toBe(false)
    expect(sample.selfMs).toBeGreaterThanOrEqual(0)
    expect(sample.heap.rssMb).toBeGreaterThan(0)
    expect(sample.eventLoop.meanMs).toBeGreaterThanOrEqual(0)
  })

  it('survives a missing sink', async () => {
    const sampler = new MainPerfSampler(() => null, TEST_INTERVAL_MS)
    sampler.subscribe('client')
    expect(sampler.isSampling()).toBe(true)
    sampler.dispose()
    expect(sampler.isSampling()).toBe(false)
  })
})
