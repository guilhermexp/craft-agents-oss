import { describe, expect, it } from 'bun:test'
import {
  ORPHANED_TASK_LINGER_MS,
  TERMINAL_TASK_LINGER_MS,
  shouldRetainBackgroundTask,
} from '../background-task-retention'

describe('shouldRetainBackgroundTask', () => {
  it('prunes terminal and orphaned tasks that have no completion timestamp', () => {
    expect(shouldRetainBackgroundTask({ status: 'completed' }, 100)).toBe(false)
    expect(shouldRetainBackgroundTask({ status: 'orphaned' }, 100)).toBe(false)
  })

  it('always retains running tasks', () => {
    expect(shouldRetainBackgroundTask({ status: 'running' }, 100)).toBe(true)
  })

  it('retains terminal tasks until their linger deadline', () => {
    expect(shouldRetainBackgroundTask(
      { status: 'completed', completedAt: 100 },
      100 + TERMINAL_TASK_LINGER_MS - 1,
    )).toBe(true)
    expect(shouldRetainBackgroundTask(
      { status: 'completed', completedAt: 100 },
      100 + TERMINAL_TASK_LINGER_MS,
    )).toBe(false)
  })

  it('retains orphaned tasks for their longer deadline', () => {
    expect(shouldRetainBackgroundTask(
      { status: 'orphaned', completedAt: 100 },
      100 + ORPHANED_TASK_LINGER_MS - 1,
    )).toBe(true)
  })
})
