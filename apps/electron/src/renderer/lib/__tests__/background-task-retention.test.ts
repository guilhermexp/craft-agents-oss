import { describe, expect, it } from 'bun:test'
import { shouldRetainBackgroundTask } from '../background-task-retention'

describe('shouldRetainBackgroundTask', () => {
  it('prunes terminal and orphaned tasks that have no completion timestamp', () => {
    expect(shouldRetainBackgroundTask({ status: 'completed' }, 100)).toBe(false)
    expect(shouldRetainBackgroundTask({ status: 'orphaned' }, 100)).toBe(false)
  })

  it('always retains running tasks', () => {
    expect(shouldRetainBackgroundTask({ status: 'running' }, 100)).toBe(true)
  })
})
