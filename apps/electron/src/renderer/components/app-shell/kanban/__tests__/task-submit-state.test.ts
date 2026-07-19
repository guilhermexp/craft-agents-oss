import { describe, expect, it } from 'bun:test'
import { ensureCreatedTask } from '../task-submit-state'

describe('ensureCreatedTask', () => {
  it('reuses the prior create result when retrying a failed run', async () => {
    const existing = { slug: 'task-one', orchestratorSessionId: 'session-1' }
    let createCalls = 0
    const result = await ensureCreatedTask(existing, async () => {
      createCalls += 1
      return { slug: 'duplicate', orchestratorSessionId: 'session-2' }
    })

    expect(result).toBe(existing)
    expect(createCalls).toBe(0)
  })

  it('creates once when there is no prior result', async () => {
    let createCalls = 0
    const result = await ensureCreatedTask(null, async () => {
      createCalls += 1
      return { slug: 'task-one', orchestratorSessionId: 'session-1' }
    })

    expect(result.slug).toBe('task-one')
    expect(createCalls).toBe(1)
  })
})
