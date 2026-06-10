/**
 * Smoke tests for the Lark adapter shell: credential parsing and the
 * construct-without-SDK contract.
 *
 * The heavy `@larksuiteoapi/node-sdk` is loaded lazily inside `initialize()`,
 * so constructing the adapter and reading its static metadata must NOT require
 * (or load) the SDK. The live WS/REST paths need real Lark credentials and a
 * network, so they are out of scope here.
 */

import { describe, it, expect } from 'bun:test'
import { LarkAdapter, parseLarkCredentials } from '../index'

describe('parseLarkCredentials', () => {
  it('parses a well-formed credential payload', () => {
    const creds = parseLarkCredentials(JSON.stringify({ appId: 'cli_x', appSecret: 's', domain: 'feishu' }))
    expect(creds).toEqual({ appId: 'cli_x', appSecret: 's', domain: 'feishu' })
  })

  it('accepts the lark domain', () => {
    expect(parseLarkCredentials(JSON.stringify({ appId: 'a', appSecret: 'b', domain: 'lark' })).domain).toBe('lark')
  })

  it('throws on missing token', () => {
    expect(() => parseLarkCredentials(undefined)).toThrow(/missing/i)
  })

  it('throws on non-JSON', () => {
    expect(() => parseLarkCredentials('not json')).toThrow(/valid JSON/i)
  })

  it('throws on missing appId', () => {
    expect(() => parseLarkCredentials(JSON.stringify({ appSecret: 'b', domain: 'lark' }))).toThrow(/appId/)
  })

  it('throws on missing appSecret', () => {
    expect(() => parseLarkCredentials(JSON.stringify({ appId: 'a', domain: 'lark' }))).toThrow(/appSecret/)
  })

  it('throws on an invalid domain', () => {
    expect(() => parseLarkCredentials(JSON.stringify({ appId: 'a', appSecret: 'b', domain: 'slack' }))).toThrow(/domain/)
  })
})

describe('LarkAdapter shell', () => {
  it('constructs without loading the SDK and reports static metadata', () => {
    const adapter = new LarkAdapter()
    expect(adapter.platform).toBe('lark')
    expect(adapter.capabilities.inlineButtons).toBe(true)
    expect(adapter.capabilities.markdown).toBe('lark-post')
    expect(adapter.capabilities.webhookSupport).toBe(false)
    expect(adapter.isConnected()).toBe(false)
  })
})
