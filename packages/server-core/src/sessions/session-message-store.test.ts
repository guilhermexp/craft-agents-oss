import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Workspace } from '@craft-agent/shared/config'
import type { Message } from '@craft-agent/core/types'
import { loadSession } from '@craft-agent/shared/sessions'
import { SessionMessageStore, type StoreManagedSession } from './session-message-store'

const tempDirs: string[] = []

async function makeWorkspace(): Promise<Workspace> {
  const rootPath = await mkdtemp(join(tmpdir(), 'craft-session-store-'))
  tempDirs.push(rootPath)
  return {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath,
  } as Workspace
}

function makeManaged(workspace: Workspace, messages: Message[]): StoreManagedSession {
  return {
    id: 'session-1',
    workspace,
    messages,
    messagesLoaded: true,
    createdAt: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SessionMessageStore', () => {
  it('persists only loaded, non-status messages without publishing events', async () => {
    const workspace = await makeWorkspace()
    const store = new SessionMessageStore()
    const managed = makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'status-1', role: 'status', content: 'working', timestamp: 2 },
    ] as Message[])

    store.persist(managed)
    await store.flush(managed.id)

    const stored = loadSession(workspace.rootPath, managed.id)
    expect(stored?.messages.map(message => message.id)).toEqual(['user-1'])
  })

  it('deduplicates concurrent lazy loads', async () => {
    const workspace = await makeWorkspace()
    const store = new SessionMessageStore()
    const managed = makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
    ] as Message[])
    store.persist(managed)
    await store.flush(managed.id)

    const unloaded = makeManaged(workspace, [])
    unloaded.messagesLoaded = false
    await Promise.all([
      store.ensureMessagesLoaded(unloaded),
      store.ensureMessagesLoaded(unloaded),
    ])

    expect(unloaded.messages.map(message => message.id)).toEqual(['user-1'])
    expect(unloaded.messagesLoaded).toBe(true)
  })
})
