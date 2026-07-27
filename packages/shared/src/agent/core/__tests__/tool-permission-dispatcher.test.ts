/**
 * Tests for ToolPermissionDispatcher — the single owner of the PreToolUse
 * orchestration shared by the Claude and Pi backends.
 *
 * Focus: the four Claude/Pi behaviours that used to diverge by accident and are
 * now deliberate configuration of one implementation, exercised through the
 * public interface (dispatch / respondToPermission / constructor options):
 *   1. post-activation strategy  → rerunAfterActivation true (rerun) vs false (STOP)
 *   2. source_activated emission → onSourceActivated fires after activation
 *   3. no source-activation handler → block (no emission)
 *   4. no permission handler on a prompt → block (never auto-allow)
 * Plus activation failure and the permission-prompt round-trip via a fake
 * PermissionRequestCallback.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  ToolPermissionDispatcher,
  type ToolPermissionContext,
  type PermissionRequestPayload,
} from '../tool-permission-dispatcher.ts';
import type { PermissionManagerLike } from '../pre-tool-use.ts';
import { setPermissionMode, getPermissionMode, cleanupModeState } from '../../mode-manager.ts';

// Nothing is whitelisted, so a non-read-only Bash command always reaches the
// ask-mode prompt decision instead of being auto-allowed.
const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => true,
  getBaseCommand: (command) => command.trim().split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

let sessionCounter = 0;
const openedSessions: string[] = [];

// runPreToolUseChecks reads the effective mode from the global mode manager
// (keyed by sessionId), not from the context — so each test seeds a fresh,
// isolated session and cleans it up afterwards.
function freshSession(mode: 'ask' | 'allow-all' | 'safe'): string {
  const sessionId = `disp-test-${++sessionCounter}`;
  setPermissionMode(sessionId, mode);
  openedSessions.push(sessionId);
  return sessionId;
}

afterEach(() => {
  for (const sessionId of openedSessions.splice(0)) cleanupModeState(sessionId);
});

interface CtxParts {
  sessionId: string;
  activeSlugs?: string[];
  allSlugs?: string[];
  onPermissionRequest?: ((payload: PermissionRequestPayload) => void) | null;
  onSourceActivationRequest?: ((slug: string) => Promise<boolean>) | null;
}

function makeCtx(parts: CtxParts): ToolPermissionContext {
  return {
    getSessionId: () => parts.sessionId,
    getWorkspaceRootPath: () => '/test/ws',
    getWorkspaceId: () => 'ws',
    getPlansFolderPath: () => undefined,
    getDataFolderPath: () => undefined,
    getWorkingDirectory: () => undefined,
    permissionManager,
    getActiveSourceSlugs: () => parts.activeSlugs ?? [],
    getAllSourceSlugs: () => parts.allSlugs ?? [],
    getPermissionMode: () => getPermissionMode(parts.sessionId),
    getPermissionRequest: () => parts.onPermissionRequest ?? null,
    getSourceActivationRequest: () => parts.onSourceActivationRequest ?? null,
  };
}

describe('ToolPermissionDispatcher — source activation divergences', () => {
  it('rerunAfterActivation=true: activates, emits, re-runs to allow (Pi strategy)', async () => {
    const sessionId = freshSession('allow-all');
    const active: string[] = [];
    const emitted: string[] = [];
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({
        sessionId,
        activeSlugs: active,
        allSlugs: ['mysource'],
        // Activation makes the source active, so the re-run passes source blocking.
        onSourceActivationRequest: async (slug) => { active.push(slug); return true; },
      }),
      { rerunAfterActivation: true, onSourceActivated: (slug) => emitted.push(slug) },
    );

    const result = await dispatcher.dispatch('mcp__mysource__do', {}, 'req-1');

    expect(result).toEqual({ type: 'allow' });
    expect(emitted).toEqual(['mysource']);
  });

  it('rerunAfterActivation=false: activates, emits, blocks with STOP (Claude strategy)', async () => {
    const sessionId = freshSession('allow-all');
    const active: string[] = [];
    const emitted: string[] = [];
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({
        sessionId,
        activeSlugs: active,
        allSlugs: ['mysource'],
        onSourceActivationRequest: async (slug) => { active.push(slug); return true; },
      }),
      { rerunAfterActivation: false, onSourceActivated: (slug) => emitted.push(slug) },
    );

    const result = await dispatcher.dispatch('mcp__mysource__do', {}, 'req-1');

    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('STOP');
      expect(result.reason).toContain('activated successfully');
      // [ALTO] The successful-activation STOP is a CONTROL-FLOW block, not an
      // error: it must NOT be marked isError, so the Claude encoder omits [ERROR].
      expect(result.isError).toBe(false);
    }
    expect(emitted).toEqual(['mysource']);
  });

  it('no source-activation handler: blocks without emitting', async () => {
    const sessionId = freshSession('allow-all');
    const emitted: string[] = [];
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, allSlugs: ['mysource'], onSourceActivationRequest: null }),
      { rerunAfterActivation: true, onSourceActivated: (slug) => emitted.push(slug) },
    );

    const result = await dispatcher.dispatch('mcp__mysource__do', {}, 'req-1');

    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('not enabled for this session');
    expect(emitted).toEqual([]);
  });

  it('activation failure: blocks without emitting', async () => {
    const sessionId = freshSession('allow-all');
    const emitted: string[] = [];
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, allSlugs: ['mysource'], onSourceActivationRequest: async () => false }),
      { rerunAfterActivation: true, onSourceActivated: (slug) => emitted.push(slug) },
    );

    const result = await dispatcher.dispatch('mcp__mysource__do', {}, 'req-1');

    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('Activate it by @mentioning');
    expect(emitted).toEqual([]);
  });

  it('a permission-mode denial is marked isError=true (real failure, gets [ERROR])', async () => {
    const sessionId = freshSession('safe');
    const dispatcher = new ToolPermissionDispatcher(makeCtx({ sessionId }));

    // Safe (read-only) mode blocks writes outright — the runPreToolUseChecks
    // 'block' arm, which is a genuine failure the model should read as an error.
    const result = await dispatcher.dispatch('Write', { file_path: '/tmp/x', content: 'y' }, 'req-1');

    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.isError).toBe(true);
  });
});

describe('ToolPermissionDispatcher — permission prompt', () => {
  it('no permission handler on a prompt: blocks instead of auto-allowing (security)', async () => {
    const sessionId = freshSession('ask');
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, onPermissionRequest: null }),
    );

    const result = await dispatcher.dispatch('Bash', { command: 'rm -rf /tmp/craft-disp-none' }, 'req-1');

    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('No permission handler');
  });

  it('with a permission handler: resolves allow on approval and block on denial', async () => {
    const sessionId = freshSession('ask');
    const captured: PermissionRequestPayload[] = [];
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, onPermissionRequest: (payload) => { captured.push(payload); } }),
    );

    const approvePromise = dispatcher.dispatch('Bash', { command: 'rm -rf /tmp/craft-disp-a' }, 'req-allow');
    await Promise.resolve();
    expect(captured.at(-1)?.requestId).toBe('req-allow');
    expect(captured.at(-1)?.command).toBe('rm -rf /tmp/craft-disp-a');
    expect(dispatcher.respondToPermission('req-allow', true)).toBe(true);
    expect(await approvePromise).toEqual({ type: 'allow' });

    const denyPromise = dispatcher.dispatch('Bash', { command: 'rm -rf /tmp/craft-disp-b' }, 'req-deny');
    await Promise.resolve();
    expect(captured).toHaveLength(2);
    expect(captured.at(-1)?.requestId).toBe('req-deny');
    expect(dispatcher.respondToPermission('req-deny', false)).toBe(true);
    const denied = await denyPromise;
    expect(denied.type).toBe('block');
    if (denied.type === 'block') expect(denied.reason).toContain('denied');
  });

  it('respondToPermission returns false for an unknown request id', () => {
    const sessionId = freshSession('ask');
    const dispatcher = new ToolPermissionDispatcher(makeCtx({ sessionId }));
    expect(dispatcher.respondToPermission('nope', true)).toBe(false);
  });

  it('clearPendingPermissions resolves a parked prompt as a block (single cleanup path)', async () => {
    const sessionId = freshSession('ask');
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, onPermissionRequest: () => {} }),
    );

    const pending = dispatcher.dispatch('Bash', { command: 'rm -rf /tmp/craft-clear' }, 'req-clear');
    await Promise.resolve();
    dispatcher.clearPendingPermissions();

    const result = await pending;
    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('denied');
  });

  it('respondToPermission returns false on a second response (no double-resolve)', async () => {
    const sessionId = freshSession('ask');
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, onPermissionRequest: () => {} }),
    );

    const pending = dispatcher.dispatch('Bash', { command: 'rm -rf /tmp/craft-dbl' }, 'req-dbl');
    await Promise.resolve();
    expect(dispatcher.respondToPermission('req-dbl', true)).toBe(true);
    expect(dispatcher.respondToPermission('req-dbl', true)).toBe(false);
    await pending;
  });

  it('an approved prompt whose input was transformed returns modify', async () => {
    const sessionId = freshSession('ask');
    const dispatcher = new ToolPermissionDispatcher(
      makeCtx({ sessionId, onPermissionRequest: () => {} }),
    );

    const pending = dispatcher.dispatch('Write', { file_path: '~/note.txt', content: 'x' }, 'req-mod');
    await Promise.resolve();
    expect(dispatcher.respondToPermission('req-mod', true)).toBe(true);

    const result = await pending;
    expect(result.type).toBe('modify');
    if (result.type === 'modify') {
      expect(String(result.input.file_path).startsWith('~')).toBe(false);
    }
  });
});

describe('ToolPermissionDispatcher — result arms', () => {
  it('call_llm is passthrough (Claude runs it in-process via the SDK)', async () => {
    const sessionId = freshSession('allow-all');
    const dispatcher = new ToolPermissionDispatcher(makeCtx({ sessionId }));

    const result = await dispatcher.dispatch('mcp__session__call_llm', {}, 'req-1');

    expect(result).toEqual({ type: 'passthrough' });
  });

  it('a ~ path is expanded into a modify result', async () => {
    const sessionId = freshSession('allow-all');
    const dispatcher = new ToolPermissionDispatcher(makeCtx({ sessionId }));

    const result = await dispatcher.dispatch('Read', { file_path: '~/notes.txt' }, 'req-1');

    expect(result.type).toBe('modify');
    if (result.type === 'modify') {
      expect(result.input.file_path).not.toBe('~/notes.txt');
      expect(String(result.input.file_path).startsWith('~')).toBe(false);
    }
  });
});
