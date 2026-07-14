/**
 * Browser bridge timeout budget (F2.4).
 *
 * Regressão: invokeClient rejeitava em 30s fixos enquanto
 * `browser_click … navigation 60000` já tinha executado o click no desktop —
 * o agente via "timeout" e re-clicava (double-submit). O budget do transporte
 * agora deriva do timeoutMs da ação (+margem, piso 30s, teto 150s) e a
 * mensagem de timeout avisa que a ação pode ter sido executada.
 */

import { describe, it, expect } from 'bun:test'
import {
  browserInvokeBudgetMs,
  requestClientBrowserInvoke,
  CLIENT_BROWSER_INVOKE,
} from './capabilities'
import type { BrowserCapabilityRequest } from './browser-capability'
import type { RpcServer } from './types'

function clickReq(timeoutMs?: number): BrowserCapabilityRequest {
  return {
    v: 1,
    method: 'clickElement',
    args: ['instance-1', '@e1', timeoutMs !== undefined ? { waitFor: 'navigation', timeoutMs } : undefined],
    sessionId: 's1',
    workspaceId: 'w1',
  }
}

describe('browserInvokeBudgetMs', () => {
  it('defaults to 30s when no action timeout is present', () => {
    expect(browserInvokeBudgetMs(clickReq())).toBe(30_000)
  })

  it('exceeds the action timeout by the margin (no replay window)', () => {
    expect(browserInvokeBudgetMs(clickReq(60_000))).toBe(65_000)
  })

  it('never goes below the base budget for short action timeouts', () => {
    expect(browserInvokeBudgetMs(clickReq(5_000))).toBe(30_000)
  })

  it('caps the budget at the transport ceiling', () => {
    expect(browserInvokeBudgetMs(clickReq(500_000))).toBe(150_000)
  })
})

describe('requestClientBrowserInvoke', () => {
  function makeFakeServer(overrides: Partial<RpcServer> = {}) {
    const calls: Array<{ via: string; timeoutMs?: number; channel: string }> = []
    const server: RpcServer = {
      handle: () => {},
      push: () => {},
      hasClientCapability: () => true,
      findClientsWithCapability: () => [],
      invokeClient: async (_clientId, channel) => {
        calls.push({ via: 'invokeClient', channel })
        return 'ok'
      },
      invokeClientWithTimeout: async (_clientId, channel, timeoutMs) => {
        calls.push({ via: 'withTimeout', timeoutMs, channel })
        return 'ok'
      },
      ...overrides,
    }
    return { server, calls }
  }

  it('routes through invokeClientWithTimeout with the derived budget', async () => {
    const { server, calls } = makeFakeServer()

    const result = await requestClientBrowserInvoke(server, 'client-1', clickReq(60_000))

    expect(result).toBe('ok')
    expect(calls).toEqual([{ via: 'withTimeout', timeoutMs: 65_000, channel: CLIENT_BROWSER_INVOKE }])
  })

  it('falls back to invokeClient when the server has no per-call timeout', async () => {
    const { server, calls } = makeFakeServer({ invokeClientWithTimeout: undefined })

    await requestClientBrowserInvoke(server, 'client-1', clickReq(60_000))

    expect(calls).toEqual([{ via: 'invokeClient', channel: CLIENT_BROWSER_INVOKE }])
  })

  it('appends the may-have-executed warning to transport timeouts', async () => {
    const { server } = makeFakeServer({
      invokeClientWithTimeout: async () => {
        const err = new Error('Client request timeout: client:browser:invoke (65000ms)')
        ;(err as any).code = 'CLIENT_REQUEST_TIMEOUT'
        throw err
      },
    })

    await expect(requestClientBrowserInvoke(server, 'client-1', clickReq(60_000)))
      .rejects.toThrow(/may still have executed.*browser_snapshot.*before retrying/)
  })

  it('leaves non-timeout errors untouched', async () => {
    const { server } = makeFakeServer({
      invokeClientWithTimeout: async () => {
        const err = new Error('Client lacks capability: client:browser:invoke')
        ;(err as any).code = 'CAPABILITY_UNAVAILABLE'
        throw err
      },
    })

    await expect(requestClientBrowserInvoke(server, 'client-1', clickReq()))
      .rejects.toThrow(/^Client lacks capability: client:browser:invoke$/)
  })
})
