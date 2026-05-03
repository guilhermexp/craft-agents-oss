import { describe, it, expect } from 'bun:test'
import { routes } from '../routes'
import { parseRoute } from '../route-parser'

describe('routes.action.newSession: channel defaults', () => {
  it('builds a route with no params', () => {
    expect(routes.action.newSession()).toBe('action/new-session')
  })

  it('encodes label only', () => {
    const route = routes.action.newSession({ label: 'channel-cert' })
    expect(route).toBe('action/new-session?label=channel-cert')
  })

  it('encodes channel defaults: label + mode + sources', () => {
    const route = routes.action.newSession({
      label: 'channel-cert',
      mode: 'safe',
      sources: ['gmail', 'slack'],
    })
    expect(route).toBe('action/new-session?label=channel-cert&mode=safe&sources=gmail%2Cslack')
  })

  it('omits sources when the list is empty', () => {
    const route = routes.action.newSession({ label: 'channel-cert', sources: [] })
    expect(route).toBe('action/new-session?label=channel-cert')
  })

  it('roundtrips through parseRoute including sources', () => {
    const route = routes.action.newSession({
      label: 'channel-cert',
      mode: 'allow-all',
      sources: ['gmail', 'github'],
    })
    const parsed = parseRoute(route)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('action')
    expect(parsed!.name).toBe('new-session')
    expect(parsed!.params.label).toBe('channel-cert')
    expect(parsed!.params.mode).toBe('allow-all')
    expect(parsed!.params.sources).toBe('gmail,github')
  })

  it('parses comma-separated sources back into an array', () => {
    const route = routes.action.newSession({ sources: ['a', 'b', 'c'] })
    const parsed = parseRoute(route)
    expect(parsed).not.toBeNull()
    const slugs = parsed!.params.sources!.split(',').map(s => s.trim()).filter(Boolean)
    expect(slugs).toEqual(['a', 'b', 'c'])
  })
})
