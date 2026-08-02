import { describe, expect, test } from 'bun:test'

import { applySourceServerBranches } from './session-source-server-application.ts'

describe('applySourceServerBranches', () => {
  test('waits for every candidate branch to settle before cleanup may restore baseline', async () => {
    let applied = 'baseline'
    let releaseDelayed: (() => void) | undefined
    let delayedStarted: (() => void) | undefined
    const delayed = new Promise<void>((resolve) => {
      releaseDelayed = resolve
    })
    const started = new Promise<void>((resolve) => {
      delayedStarted = resolve
    })
    let rejected = false

    const application = applySourceServerBranches(
      async () => {
        throw new Error('bridge failed with provider-token-sentinel')
      },
      async () => {
        delayedStarted?.()
        await delayed
        applied = 'candidate'
      },
    ).catch(() => {
      rejected = true
      applied = 'baseline'
    })

    await started
    await Promise.resolve()
    expect(rejected).toBe(false)
    expect(applied).toBe('baseline')

    releaseDelayed?.()
    await application
    expect(rejected).toBe(true)
    expect(applied).toBe('baseline')
  })
})
