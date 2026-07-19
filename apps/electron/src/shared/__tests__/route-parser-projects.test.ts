import { describe, expect, it } from 'bun:test'
import { buildCompoundRoute, buildRouteFromNavigationState, parseCompoundRoute, parseRouteToNavigationState } from '../route-parser'
import { routes } from '../routes'

describe('route-parser: projects routes', () => {
  it('parses projects list route', () => {
    const result = parseCompoundRoute('projects')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('projects')
    expect(result!.details).toBeNull()
  })

  it('parses and builds project detail route', () => {
    const result = parseCompoundRoute('projects/project/project-1')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('projects')
    expect(result!.details).toEqual({ type: 'project', id: 'project-1' })
    expect(buildCompoundRoute(result!)).toBe('projects/project/project-1')
  })

  it('converts project detail route to navigation state', () => {
    const state = parseRouteToNavigationState(routes.view.projects('project-1'))
    if (!state) throw new Error('Expected navigation state')
    expect(state.navigator).toBe('projects')
    if (state.navigator !== 'projects') {
      throw new Error(`Expected projects navigator, got ${state.navigator}`)
    }
    expect(state.details).toEqual({ type: 'project', projectSlug: 'project-1' })
  })

  it('round-trips projects navigation state through buildRouteFromNavigationState', () => {
    const state = parseRouteToNavigationState('projects')
    if (!state) throw new Error('Expected navigation state')
    expect(buildRouteFromNavigationState(state)).toBe('projects')
  })

  it('rejects malformed projects paths', () => {
    expect(parseCompoundRoute('projects/extra')).toBeNull()
    expect(parseCompoundRoute('projects/project')).toBeNull()
    expect(parseCompoundRoute('projects/not-project/abc')).toBeNull()
  })
})
