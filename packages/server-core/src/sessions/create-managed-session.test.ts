import { describe, expect, it } from 'bun:test'
import { createManagedSession, createSpawnedSessionOptions } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('normalizes legacy thinkingLevel=think on restore', () => {
    const managed = createManagedSession({
      id: 'session_legacy',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      id: 'session_invalid',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })
})

describe('createSpawnedSessionOptions', () => {
  const parent = {
    id: 'parent-session',
    llmConnection: 'hermes',
    model: 'gpt-5.5',
    enabledSourceSlugs: ['github'],
    permissionMode: 'ask' as const,
    thinkingLevel: 'medium' as const,
    labels: ['Parent'],
    projectId: 'project-1',
  }

  it('keeps inheriting the parent model when the spawned session uses the parent connection', () => {
    expect(createSpawnedSessionOptions({ prompt: 'work' }, parent).model).toBe('gpt-5.5')
    expect(createSpawnedSessionOptions({ prompt: 'work', llmConnection: 'hermes' }, parent).model).toBe('gpt-5.5')
  })

  it('uses the target connection default when llmConnection changes and no model is explicit', () => {
    const options = createSpawnedSessionOptions({
      prompt: 'work',
      llmConnection: 'claude-max',
    }, parent)

    expect(options.llmConnection).toBe('claude-max')
    expect(options.model).toBe('default')
  })

  it('preserves an explicit model even when llmConnection changes', () => {
    const options = createSpawnedSessionOptions({
      prompt: 'work',
      llmConnection: 'claude-max',
      model: 'claude-opus-4-8',
    }, parent)

    expect(options.llmConnection).toBe('claude-max')
    expect(options.model).toBe('claude-opus-4-8')
  })
})
