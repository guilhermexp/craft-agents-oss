import { describe, expect, it } from 'bun:test'

import { createRpcProbe } from '../../../../preload/rpc-probe'

const inner = {
  invoke: (channel: string) =>
    channel === 'boom' ? Promise.reject(new Error('nope')) : Promise.resolve('ok'),
  on: () => () => {},
  handleCapability: () => {},
}

describe('createRpcProbe', () => {
  it('records nothing while disabled', async () => {
    const probe = createRpcProbe(inner)
    await probe.client.invoke('a')
    expect(probe.bridge.drain()).toEqual([])
  })

  it('times calls, counts errors separately, and drains to empty', async () => {
    const probe = createRpcProbe(inner)
    probe.bridge.setEnabled(true)

    await probe.client.invoke('a')
    await probe.client.invoke('a')
    await probe.client.invoke('boom').catch(() => {})

    const stats = probe.bridge.drain()
    const a = stats.find((s) => s.channel === 'a')
    const boom = stats.find((s) => s.channel === 'boom')
    expect(a?.calls).toBe(2)
    expect(a?.errors).toBe(0)
    expect(boom?.calls).toBe(1)
    expect(boom?.errors).toBe(1)

    // Draining resets the window so the next second starts clean.
    expect(probe.bridge.drain()).toEqual([])
  })

  it('clears stats when tracking is toggled', async () => {
    const probe = createRpcProbe(inner)
    probe.bridge.setEnabled(true)
    await probe.client.invoke('a')
    probe.bridge.setEnabled(false)
    expect(probe.bridge.drain()).toEqual([])
  })
})
