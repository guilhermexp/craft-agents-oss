import { describe, expect, it } from 'bun:test'
import type { Workspace } from '@craft-agent/shared/config'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { ManagedSession } from './SessionManager.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { SessionMessageStore } from './session-message-store'

const TEST_WORKSPACE = { id: 'ws', name: 'ws', rootPath: '/tmp/adopt-guard', createdAt: Date.now() } as Workspace

// Locks the adoption state machine that prevents "Generate → Create & Run" from minting a duplicate
// top-level orchestrator (#bug1). The success path needs full storage wiring, so here we pin the
// four guard branches that must NEVER promote — they're the correctness guarantees the external
// review asked for (no silent capture of an unrelated/non-draft session).
describe('adoptGeneratedTaskOrchestrator guards', () => {
  function seed(sm: SessionManager, id: string, fields: { taskDraft?: boolean; taskSlug?: string }) {
    sm.registerManagedSession(createManagedSession({ id, ...fields }, TEST_WORKSPACE, { messagesLoaded: true }))
  }

  it('returns false when the session does not exist', async () => {
    const sm = new SessionManager()
    expect(await sm.adoptGeneratedTaskOrchestrator('missing', 'slug-a')).toBe(false)
  })

  it('returns false when the session is not a task draft', async () => {
    const sm = new SessionManager()
    seed(sm, 'plain', { taskDraft: false })
    expect(await sm.adoptGeneratedTaskOrchestrator('plain', 'slug-a')).toBe(false)
  })

  it('is an idempotent no-op (true) when already bound to the same slug', async () => {
    const sm = new SessionManager()
    seed(sm, 'orch', { taskDraft: false, taskSlug: 'slug-a' })
    expect(await sm.adoptGeneratedTaskOrchestrator('orch', 'slug-a')).toBe(true)
  })

  it('refuses (false) to rebind a session already bound to a different slug', async () => {
    const sm = new SessionManager()
    seed(sm, 'orch', { taskDraft: false, taskSlug: 'slug-a' })
    expect(await sm.adoptGeneratedTaskOrchestrator('orch', 'slug-b')).toBe(false)
    // The existing binding is untouched.
    expect(sm.getManagedSession('orch')!.taskSlug).toBe('slug-a')
  })
})

// bindExistingSessionToTask attaches an authored spec onto a *visible* (non-draft) tile — the
// edit-mode save path. Unlike adopt it doesn't require `taskDraft`, but it must still never
// hijack a session already owned by a different task. The success path persists/flushes (needs
// storage wiring), so we pin the three early-return guards that run before any I/O.
describe('bindExistingSessionToTask guards', () => {
  function seed(sm: SessionManager, id: string, fields: { taskDraft?: boolean; taskSlug?: string }) {
    sm.registerManagedSession(createManagedSession({ id, ...fields }, TEST_WORKSPACE, { messagesLoaded: true }))
  }

  it('returns false when the session does not exist', async () => {
    const sm = new SessionManager()
    expect(await sm.bindExistingSessionToTask('missing', 'slug-a')).toBe(false)
  })

  it('is an idempotent no-op (true) when already bound to the same slug', async () => {
    const sm = new SessionManager()
    seed(sm, 'orch', { taskSlug: 'slug-a' })
    expect(await sm.bindExistingSessionToTask('orch', 'slug-a')).toBe(true)
  })

  it('refuses (false) to rebind a session already owned by a different slug', async () => {
    const sm = new SessionManager()
    seed(sm, 'orch', { taskSlug: 'slug-a' })
    expect(await sm.bindExistingSessionToTask('orch', 'slug-b')).toBe(false)
    // The existing binding is untouched.
    expect(sm.getManagedSession('orch')!.taskSlug).toBe('slug-a')
  })
})

// PR #415 follow-up: adopt/bind must route model/cwd/permission through the canonical live-update
// mutators (so the running agent + renderer stay consistent, not just the on-disk metadata), and
// must NOT churn the agent when nothing changed. We stub the (separately-tested) mutators + the
// persistence seam so these tests isolate the delegation contract without full storage wiring.
describe('adopt/bind route changed fields through canonical live-update mutators', () => {
  function harness(seedFields: Partial<ManagedSession>) {
    // Stub the persistence seam so the delegation contract is exercised without storage wiring;
    // the canonical mutators (updateSessionModel/updateWorkingDirectory/setSessionPermissionMode)
    // are public, so spy them directly; emitted events are captured via the public event sink.
    const store = new SessionMessageStore()
    store.persist = () => {}
    store.flush = async () => {}
    const sm = new SessionManager({ store })
    const calls = { model: [] as unknown[], cwd: [] as unknown[], mode: [] as unknown[] }
    const events: string[] = []
    sm.setEventSink((_channel, _target, event: SessionEvent) => { events.push(event.type) })
    sm.updateSessionModel = async (_id, _ws, m) => { calls.model.push(m) }
    sm.updateWorkingDirectory = (_id, p) => { calls.cwd.push(p) }
    sm.setSessionPermissionMode = (_id, m) => { calls.mode.push(m) }
    sm.registerManagedSession(createManagedSession({
      id: 's',
      taskDraft: true,
      connectionLocked: false,
      model: 'old-model',
      llmConnection: 'old-conn',
      permissionMode: 'ask',
      workingDirectory: '/old/dir',
      ...seedFields,
    }, TEST_WORKSPACE, { messagesLoaded: true }))
    return { sm, calls, events }
  }

  const CHANGED = { model: 'new-model', workingDirectory: '/new/dir', permissionMode: 'allow-all' as const, llmConnection: 'new-conn' }

  it('adopt delegates each changed field to its canonical mutator + sets connection directly', async () => {
    const { sm, calls, events } = harness({})
    expect(await sm.adoptGeneratedTaskOrchestrator('s', 'slug', CHANGED)).toBe(true)
    expect(calls.model).toEqual(['new-model'])
    expect(calls.cwd).toEqual(['/new/dir'])
    expect(calls.mode).toEqual(['allow-all'])
    // Connection can't go through setSessionConnection (session has started) → set directly + event.
    expect(sm.getManagedSession('s')!.llmConnection).toBe('new-conn')
    expect(events).toContain('connection_changed')
    expect(events).toContain('session_metadata_changed')
  })

  it('adopt does NOT touch the mutators when nothing changed (no agent churn)', async () => {
    const { sm, calls } = harness({ model: 'm', workingDirectory: '/d', permissionMode: 'ask', llmConnection: 'c' })
    expect(
      await sm.adoptGeneratedTaskOrchestrator('s', 'slug', {
        model: 'm', workingDirectory: '/d', permissionMode: 'ask', llmConnection: 'c',
      }),
    ).toBe(true)
    expect(calls.model).toEqual([])
    expect(calls.cwd).toEqual([])
    expect(calls.mode).toEqual([])
  })

  it('bind delegates each changed field to its canonical mutator', async () => {
    const { sm, calls } = harness({ taskDraft: false })
    expect(await sm.bindExistingSessionToTask('s', 'slug', CHANGED)).toBe(true)
    expect(calls.model).toEqual(['new-model'])
    expect(calls.cwd).toEqual(['/new/dir'])
    expect(calls.mode).toEqual(['allow-all'])
  })

  it('bind does NOT touch the mutators when nothing changed', async () => {
    const { sm, calls } = harness({ taskDraft: false, model: 'm', workingDirectory: '/d', permissionMode: 'ask', llmConnection: 'c' })
    expect(
      await sm.bindExistingSessionToTask('s', 'slug', {
        model: 'm', workingDirectory: '/d', permissionMode: 'ask', llmConnection: 'c',
      }),
    ).toBe(true)
    expect(calls.model).toEqual([])
    expect(calls.cwd).toEqual([])
    expect(calls.mode).toEqual([])
  })

  // TaskEditor retry: create succeeds, run fails, the user edits the title/model/etc. and retries.
  // The retry re-binds to the *same* slug — that must reconcile the edits, not silently no-op.
  it('bind reconciles changed fields on a retry re-bind of the same already-bound slug', async () => {
    const { sm, calls, events } = harness({ taskDraft: false, taskSlug: 'slug' })
    expect(await sm.bindExistingSessionToTask('s', 'slug', { ...CHANGED, name: 'Edited title' })).toBe(true)
    expect(calls.model).toEqual(['new-model'])
    expect(calls.cwd).toEqual(['/new/dir'])
    expect(calls.mode).toEqual(['allow-all'])
    const session = sm.getManagedSession('s')!
    expect(session.name).toBe('Edited title')
    expect(session.llmConnection).toBe('new-conn')
    expect(events).toContain('name_changed')
    expect(events).toContain('connection_changed')
    expect(events).toContain('session_metadata_changed')
  })

  it('adopt reconciles changed fields on a retry re-adopt of the same already-bound slug', async () => {
    const { sm, calls } = harness({ taskDraft: false, taskSlug: 'slug' })
    expect(await sm.adoptGeneratedTaskOrchestrator('s', 'slug', { ...CHANGED, name: 'Edited title' })).toBe(true)
    expect(calls.model).toEqual(['new-model'])
    expect(calls.cwd).toEqual(['/new/dir'])
    expect(calls.mode).toEqual(['allow-all'])
    expect(sm.getManagedSession('s')!.name).toBe('Edited title')
  })

  it('bind stays a true no-op (no mutator/event calls) on a retry re-bind with nothing changed', async () => {
    const { sm, calls, events } = harness({ taskDraft: false, taskSlug: 'slug' })
    expect(await sm.bindExistingSessionToTask('s', 'slug')).toBe(true)
    expect(calls.model).toEqual([])
    expect(calls.cwd).toEqual([])
    expect(calls.mode).toEqual([])
    expect(events).toEqual([])
  })
})
