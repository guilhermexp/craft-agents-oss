import { describe, expect, it } from 'bun:test'
import { buildCompoundRoute, parseCompoundRoute, parseRouteToNavigationState } from '../route-parser'
import { routes } from '../routes'

describe('route-parser: meetings routes', () => {
  it('parses meetings list route', () => {
    const result = parseCompoundRoute('meetings')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('meetings')
    expect(result!.details).toBeNull()
  })

  it('parses and builds meeting detail route', () => {
    const result = parseCompoundRoute('meetings/meeting/meeting-1')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('meetings')
    expect(result!.details).toEqual({ type: 'meeting', id: 'meeting-1' })
    expect(buildCompoundRoute(result!)).toBe('meetings/meeting/meeting-1')
  })

  it('converts meeting detail route to navigation state', () => {
    const state = parseRouteToNavigationState(routes.view.meetings('meeting-1'))
    if (!state) throw new Error('Expected navigation state')
    expect(state.navigator).toBe('meetings')
    if (state.navigator !== 'meetings') {
      throw new Error(`Expected meetings navigator, got ${state.navigator}`)
    }
    expect(state.details).toEqual({ type: 'meeting', meetingId: 'meeting-1' })
  })

  it('encodes and decodes IDs containing special characters', () => {
    const idWithSpecials = 'meeting/with spaces?and#hash'
    const built = routes.view.meetings(idWithSpecials)
    expect(built).toBe(`meetings/meeting/${encodeURIComponent(idWithSpecials)}`)
    const parsed = parseCompoundRoute(built)
    expect(parsed!.details).toEqual({ type: 'meeting', id: idWithSpecials })
  })

  it('rejects malformed meetings paths', () => {
    expect(parseCompoundRoute('meetings/extra')).toBeNull()
    expect(parseCompoundRoute('meetings/meeting')).toBeNull()
    expect(parseCompoundRoute('meetings/meeting/abc/extra')).toBeNull()
    expect(parseCompoundRoute('meetings/not-meeting/abc')).toBeNull()
  })
})
