/**
 * The "No Response" guard, exercised the way `sendMessage` reaches it.
 *
 * A turn that ends with no assistant message lands on a visible retryable card
 * (fix-tool-block-turn-continuation). That is right for a silent failure — a
 * refused tool that killed the turn — and wrong for a turn the user ended on
 * purpose, where "Response interrupted" already renders.
 *
 * The distinction is *abort*, not *queue*. `queue` is the default mid-stream
 * behavior for `anthropic` connections: the user's message is held, nothing is
 * aborted, and the running turn goes to natural completion. Suppressing the
 * card because something sits in `messageQueue` hides exactly the failure this
 * change exists to expose, and the queued message replaying as a new turn makes
 * the dead turn invisible.
 *
 * So the state here is built by the real production paths — `sendMessage`'s
 * mid-stream branch and the `steer_undelivered` event — on a real
 * `ManagedSession`, and the guard is called with that session, exactly as the
 * `complete` branch does.
 *
 * Isolated: `CONFIG_DIR` is resolved at config-module load, so
 * `CRAFT_CONFIG_DIR` must point at the fixture before any import — the
 * connection is what decides steer-vs-queue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedSession, SessionManager as SessionManagerType } from './SessionManager.ts'

const configDir = mkdtempSync(join(tmpdir(), 'craft-no-response-'))
process.env.CRAFT_CONFIG_DIR = configDir
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  workspaces: [],
  defaultLlmConnection: 'claude-api',
  llmConnections: [
    // anthropic → resolveMidStreamBehavior gives 'queue'
    { slug: 'claude-api', name: 'Claude', providerType: 'anthropic', authType: 'api_key' },
    // pi → 'steer'
    { slug: 'pi-openai', name: 'OpenAI', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key' },
  ],
}))

// Dynamic on purpose: a static import would load the config module — and
// freeze CONFIG_DIR — before the assignment above runs. The type side is
// imported statically, so nothing here is untyped.
const { SessionManager, createManagedSession, shouldReportMissingAssistantResponse } =
  await import('./SessionManager.ts')

describe('missing-response guard at the sendMessage call site', () => {
  let tmpRoot: string
  let sm: SessionManagerType

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-no-response-'))
    mkdirSync(tmpRoot, { recursive: true })
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, llmConnection: string): ManagedSession {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'no-response test', llmConnection },
      workspace as never,
      { messagesLoaded: true },
    )
    sm.registerManagedSession(managed)
    // What `sendMessage` does at turn start: baseline the last final assistant
    // message so the guard can tell "this turn answered" from "an older one did".
    managed.turnStartFinalMessageId = undefined
    managed.isProcessing = true
    return managed
  }

  function pushAssistantMessage(managed: ManagedSession, id: string) {
    managed.messages.push({
      id,
      role: 'assistant',
      content: 'here you go',
      timestamp: Date.now(),
    } as never)
  }

  it('reports a turn that went silent on its own', () => {
    const managed = buildSession('silent', 'claude-api')
    expect(shouldReportMissingAssistantResponse(managed)).toBe(true)
  })

  it('reports the turn when a mid-stream message was only queued (anthropic default)', async () => {
    const managed = buildSession('queued-no-abort', 'claude-api')

    // Real 'queue' path: no agent.redirect(), no forceAbort, the turn keeps
    // running. This is what every user who types during a Claude turn does.
    await sm.sendMessage('queued-no-abort', 'actually, do the other thing')

    expect(managed.messageQueue.length).toBe(1)
    expect(managed.wasInterrupted).toBeFalsy()
    expect(shouldReportMissingAssistantResponse(managed)).toBe(true)
  })

  it('reports the turn when an undelivered steer was re-queued', async () => {
    const managed = buildSession('steer-undelivered', 'claude-api')

    // The turn-ending permission denial: the turn died without a word and the
    // pending steer comes back through the event channel. Nothing aborted it.
    await sm.dispatchAgentEvent(managed, {
      type: 'steer_undelivered',
      message: 'actually, do the other thing',
    } as never)

    expect(managed.messageQueue.length).toBe(1)
    expect(shouldReportMissingAssistantResponse(managed)).toBe(true)
  })

  it('stays quiet when a failed redirect aborted the turn (steer mode)', async () => {
    const managed = buildSession('steer-aborted', 'pi-openai')
    // Every backend `redirect()` that returns false has already called
    // forceAbort(AbortReason.Redirect) — the turn is genuinely cut short.
    managed.agent = { redirect: () => false } as never

    await sm.sendMessage('steer-aborted', 'stop and do this instead')

    expect(managed.messageQueue.length).toBe(1)
    expect(managed.wasInterrupted).toBe(true)
    expect(shouldReportMissingAssistantResponse(managed)).toBe(false)
  })

  it('reports the turn when the steer was accepted and the turn still said nothing', async () => {
    const managed = buildSession('steer-accepted', 'pi-openai')
    managed.agent = { redirect: () => true } as never

    await sm.sendMessage('steer-accepted', 'also check the other file')

    expect(managed.messageQueue.length).toBe(0)
    expect(shouldReportMissingAssistantResponse(managed)).toBe(true)
  })

  it('stays quiet after an explicit Stop', () => {
    const managed = buildSession('stopped', 'claude-api')
    // Set directly rather than through cancelProcessing(): that arms a real 5s
    // cleanup timer, which has no place in a unit test.
    managed.stopRequested = true
    managed.wasInterrupted = true

    expect(shouldReportMissingAssistantResponse(managed)).toBe(false)
  })

  it('stays quiet when this turn did answer, even with a message queued behind it', async () => {
    const managed = buildSession('answered-then-queued', 'claude-api')
    pushAssistantMessage(managed, 'assistant-1')

    // The user types after the assistant text but before `complete`. The
    // caller's timestamp comparison sees a user message newer than the reply;
    // the turn baseline knows the turn answered.
    await sm.sendMessage('answered-then-queued', 'one more thing')

    expect(managed.messageQueue.length).toBe(1)
    expect(shouldReportMissingAssistantResponse(managed)).toBe(false)
  })

  it('reports the turn when the only assistant message predates it', () => {
    const managed = buildSession('older-answer-only', 'claude-api')
    pushAssistantMessage(managed, 'assistant-1')
    managed.turnStartFinalMessageId = 'assistant-1'

    expect(shouldReportMissingAssistantResponse(managed)).toBe(true)
  })
})
