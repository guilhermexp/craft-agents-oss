/**
 * RemoteBrowserPaneManager unit tests.
 *
 * Verifies wire packaging, host-client gating, screenshot byte round-trip, and
 * that every data-returning method hits the wire (no fabricated sync stubs).
 * Uses a fake RpcServer instead of a real WS pair — we only care about the
 * BrowserCapabilityRequest shape the bridge produces.
 */

import { describe, it, expect } from 'bun:test'
import { createRemoteBrowserPaneManager } from '../RemoteBrowserPaneManager'
import { CLIENT_BROWSER_INVOKE, type BrowserCapabilityRequest } from '../../transport'
import type { RpcServer } from '../../transport/types'

interface FakeServerCall {
  clientId: string
  channel: string
  args: unknown[]
}

function createFakeServer(opts?: {
  invokeImpl?: (call: FakeServerCall) => unknown
  capabilityClients?: Set<string>
}): { server: RpcServer; calls: FakeServerCall[] } {
  const calls: FakeServerCall[] = []
  const server: RpcServer = {
    handle() {},
    push() {},
    async invokeClient(clientId, channel, ...args) {
      const call = { clientId, channel, args }
      calls.push(call)
      return opts?.invokeImpl?.(call) ?? undefined
    },
    hasClientCapability(clientId) {
      return opts?.capabilityClients?.has(clientId) ?? true
    },
    findClientsWithCapability() {
      return opts?.capabilityClients ? [...opts.capabilityClients] : []
    },
  }
  return { server, calls }
}

function makeBridge(server: RpcServer, getHostClient: () => string | null = () => 'client-A') {
  return createRemoteBrowserPaneManager({ sessionId: 'sess-1', workspaceId: 'ws-1', rpcServer: server, getHostClient })
}

describe('RemoteBrowserPaneManager — wire packaging', () => {
  it('packages a method into a BrowserCapabilityRequest with sessionId + workspaceId', async () => {
    const { server, calls } = createFakeServer({ invokeImpl: () => ({ url: 'https://x', title: 't' }) })
    const bridge = makeBridge(server)
    await bridge.navigate('inst-1', 'https://example.com')

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.clientId).toBe('client-A')
    expect(c.channel).toBe(CLIENT_BROWSER_INVOKE)
    const req = c.args[0] as BrowserCapabilityRequest
    expect(req.v).toBe(1)
    expect(req.method).toBe('navigate')
    expect(req.sessionId).toBe('sess-1')
    expect(req.workspaceId).toBe('ws-1')
    expect(req.args).toEqual(['inst-1', 'https://example.com'])
  })

  it('createForSession awaits the WS round-trip and returns the resolved id', async () => {
    const { server } = createFakeServer({ invokeImpl: () => 'browser-7' })
    const bridge = makeBridge(server)
    const id = await bridge.createForSession('sess-1', { show: true })
    expect(id).toBe('browser-7')
  })

  it('forwards a method it has no explicit handler for (generic proxy)', async () => {
    const { server, calls } = createFakeServer({ invokeImpl: () => ({ ok: true, kind: 'selector', elapsedMs: 1, detail: 'x' }) })
    const bridge = makeBridge(server)
    await bridge.waitFor('inst-1', { kind: 'selector', value: '#x' })
    const req = calls[0]!.args[0] as BrowserCapabilityRequest
    expect(req.method).toBe('waitFor')
    expect(req.args).toEqual(['inst-1', { kind: 'selector', value: '#x' }])
  })

  it('throws BROWSER_NO_CAPABLE_CLIENT when no host client is connected', async () => {
    const { server } = createFakeServer()
    const bridge = makeBridge(server, () => null)

    let caught: unknown
    try {
      await bridge.navigate('inst-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('BROWSER_NO_CAPABLE_CLIENT')
  })

  it('throws BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED for uploadFile', async () => {
    const { server, calls } = createFakeServer()
    const bridge = makeBridge(server)

    let caught: unknown
    try {
      await bridge.uploadFile('inst-1', 'ref', ['/some/file'])
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED')
    expect(calls).toHaveLength(0)  // never hits the wire
  })

  it('throws CAPABILITY_UNAVAILABLE when host client does not advertise the capability', async () => {
    const { server } = createFakeServer({ capabilityClients: new Set([]) })
    const bridge = makeBridge(server, () => 'client-A')  // returns id, but server says they lack the cap

    let caught: unknown
    try {
      await bridge.navigate('inst-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('CAPABILITY_UNAVAILABLE')
  })
})

describe('RemoteBrowserPaneManager — screenshot wire conversion', () => {
  it('converts Uint8Array imageBytes → Buffer', async () => {
    const sample = new Uint8Array([1, 2, 3, 4, 5])
    const { server } = createFakeServer({
      invokeImpl: () => ({ imageBytes: sample, imageFormat: 'png', metadata: { ok: true } }),
    })
    const bridge = makeBridge(server)

    const result = await bridge.screenshot('inst-1')
    expect(Buffer.isBuffer(result.imageBuffer)).toBe(true)
    expect(Array.from(result.imageBuffer)).toEqual([1, 2, 3, 4, 5])
    expect(result.imageFormat).toBe('png')
    expect(result.metadata).toEqual({ ok: true })
  })

  it('handles wire arrival as serialized {data} object (structured-clone variant)', async () => {
    const { server } = createFakeServer({
      invokeImpl: () => ({ imageBytes: { data: [9, 8, 7] }, imageFormat: 'jpeg' }),
    })
    const bridge = makeBridge(server)

    const result = await bridge.screenshot('inst-1')
    expect(Array.from(result.imageBuffer)).toEqual([9, 8, 7])
    expect(result.imageFormat).toBe('jpeg')
  })
})

describe('RemoteBrowserPaneManager — async transport (no fabricated values)', () => {
  it('listInstances hits the wire and returns the real result (no sync stub)', async () => {
    const wire = [{ id: 'i1' }]
    const { server, calls } = createFakeServer({ invokeImpl: () => wire })
    const bridge = makeBridge(server)

    const result = await bridge.listInstances()
    expect(result).toEqual(wire as never)
    expect(calls).toHaveLength(1)
    expect((calls[0]!.args[0] as BrowserCapabilityRequest).method).toBe('listInstances')
  })

  it('getInstance / console / network / resize await the real invoke result', async () => {
    const results: Record<string, unknown> = {
      getInstance: { ownerType: 'session', ownerSessionId: 'sess-1', isVisible: true, title: 't', currentUrl: 'https://x' },
      getConsoleLogs: [{ level: 'error', message: 'boom', timestamp: 1 }],
      getNetworkLogs: [{ method: 'GET', url: 'https://x', status: 500, ok: false }],
      windowResize: { width: 1024, height: 768 },
    }
    const { server, calls } = createFakeServer({
      invokeImpl: (call) => results[(call.args[0] as BrowserCapabilityRequest).method],
    })
    const bridge = makeBridge(server)

    expect(await bridge.getInstance('inst-1')).toEqual(results.getInstance as never)
    expect(await bridge.getConsoleLogs('inst-1', { level: 'error' })).toEqual(results.getConsoleLogs as never)
    expect(await bridge.getNetworkLogs('inst-1', { status: 'failed' })).toEqual(results.getNetworkLogs as never)
    expect(await bridge.windowResize('inst-1', 1024, 768)).toEqual(results.windowResize as { width: number; height: number })

    const methods = calls.map((c) => (c.args[0] as BrowserCapabilityRequest).method)
    expect(methods).toEqual(['getInstance', 'getConsoleLogs', 'getNetworkLogs', 'windowResize'])
  })
})
