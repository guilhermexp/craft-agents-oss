import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredSession } from '../types.ts'
import { listSessions, loadSession, saveSession, updateSessionMetadata } from '../storage.ts'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `hermes-profile-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(workspaceRootPath: string): StoredSession {
  return {
    id: 'session-1',
    workspaceRootPath,
    createdAt: 1000,
    lastUsedAt: 1000,
    hermesProfile: 'devops',
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

describe('Hermes profile session persistence', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('round-trips hermesProfile through JSONL load and session listing', async () => {
    await saveSession(makeStoredSession(workspaceRoot))

    expect(loadSession(workspaceRoot, 'session-1')?.hermesProfile).toBe('devops')
    expect(listSessions(workspaceRoot)[0]?.hermesProfile).toBe('devops')
  })

  it('updates hermesProfile through metadata updates', async () => {
    await saveSession(makeStoredSession(workspaceRoot))

    await updateSessionMetadata(workspaceRoot, 'session-1', { hermesProfile: 'server-ops' })

    expect(loadSession(workspaceRoot, 'session-1')?.hermesProfile).toBe('server-ops')
  })
})
