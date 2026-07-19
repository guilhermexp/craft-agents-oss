interface RetainedBackgroundTask {
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'
  completedAt?: number
}

export const TERMINAL_TASK_LINGER_MS = 8_000
export const ORPHANED_TASK_LINGER_MS = 20_000

export function shouldRetainBackgroundTask(task: RetainedBackgroundTask, now: number): boolean {
  if (task.status === 'running') return true
  if (task.completedAt === undefined) return false
  const linger = task.status === 'orphaned' ? ORPHANED_TASK_LINGER_MS : TERMINAL_TASK_LINGER_MS
  return now - task.completedAt < linger
}
