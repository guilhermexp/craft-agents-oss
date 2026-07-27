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

function nextImmediate(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
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

  it('persistNow lands the write on disk instead of leaving it behind the debounce', async () => {
    const workspace = await makeWorkspace()
    const store = new SessionMessageStore()
    const managed = makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
    ] as Message[])

    await store.persistNow(managed)

    expect(loadSession(workspace.rootPath, managed.id)?.messages.map(m => m.id)).toEqual(['user-1'])
  })

  it('persistMetadataNow arms the self-write guard before the write', async () => {
    const workspace = await makeWorkspace()
    const store = new SessionMessageStore()
    const managed = makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
    ] as Message[])
    expect(managed._metadataWriteGuardUntil).toBeUndefined()

    const before = Date.now()
    await store.persistMetadataNow(managed)

    // The watcher compares `Date.now()` against this deadline, so it must sit in
    // the future by the guard window — an unarmed write lets the fs.watch echo
    // of our own atomic rename revert the mutation we just persisted.
    expect(managed._metadataWriteGuardUntil).toBeGreaterThan(before)
    expect(loadSession(workspace.rootPath, managed.id)).not.toBeNull()
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

  it('cold persist hydrates messages from disk so a metadata-only change does not clobber them', async () => {
    const workspace = await makeWorkspace()
    const store = new SessionMessageStore()
    // Seed disk with a message via a hot persist.
    store.persist(makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
    ] as Message[]))
    await store.flush('session-1')

    // A cold session (messages never lazy-loaded) with only a metadata mutation.
    const cold = makeManaged(workspace, [])
    cold.messagesLoaded = false
    cold.name = 'renamed while cold'
    store.persist(cold)
    await store.flush(cold.id)

    const stored = loadSession(workspace.rootPath, cold.id)
    // Existing messages preserved (not overwritten with []).
    expect(stored?.messages.map(message => message.id)).toEqual(['user-1'])
    // The metadata mutation still lands.
    expect(stored?.name).toBe('renamed while cold')
    // The session is now hydrated in memory.
    expect(cold.messagesLoaded).toBe(true)
    expect(cold.messages.map(message => message.id)).toEqual(['user-1'])
  })

  it('cold persist recovers queued messages so #616 durability survives a metadata-only write', async () => {
    const workspace = await makeWorkspace()
    const recovered: string[] = []
    const store = new SessionMessageStore({
      onQueuedMessagesRecovered: sessionId => recovered.push(sessionId),
    })
    // Seed disk with a user message persisted as queued-but-unprocessed (the #616 state).
    store.persist(makeManaged(workspace, [
      { id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1, isQueued: true },
    ] as Message[]))
    await store.flush('session-1')

    // A cold session receiving a metadata-only persist — the exact path a rename /
    // flag / label mutation takes after a restart, before the session is ever opened.
    const cold = makeManaged(workspace, [])
    cold.messagesLoaded = false
    cold.name = 'renamed while cold'
    store.persist(cold)
    // onQueuedMessagesRecovered fires on the next tick (setImmediate).
    await nextImmediate()

    // The queued message is back in the queue and the recovery callback fired.
    expect(cold.messageQueue?.length).toBe(1)
    expect(cold.messageQueue?.[0]?.messageId).toBe('user-1')
    expect(recovered).toEqual(['session-1'])

    // ensureMessagesLoaded now short-circuits (already loaded) and must not
    // double-recover: the queue and callback count stay put.
    await store.ensureMessagesLoaded(cold)
    await nextImmediate()
    expect(cold.messageQueue?.length).toBe(1)
    expect(recovered).toEqual(['session-1'])
  })
})
