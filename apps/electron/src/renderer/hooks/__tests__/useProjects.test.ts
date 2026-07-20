import { describe, expect, it } from 'bun:test'
import { shouldApplyProjectsResult } from '../useProjects'

describe('shouldApplyProjectsResult', () => {
  it('rejects an older refresh after a broadcast advances the generation', () => {
    expect(shouldApplyProjectsResult(1, 2, 'workspace-a', 'workspace-a')).toBe(false)
  })

  it('rejects a refresh after the active workspace changes', () => {
    expect(shouldApplyProjectsResult(2, 2, 'workspace-a', 'workspace-b')).toBe(false)
  })

  it('accepts only the latest refresh for the current workspace', () => {
    expect(shouldApplyProjectsResult(2, 2, 'workspace-a', 'workspace-a')).toBe(true)
  })
})
