/**
 * The Claude PreToolUse encoder maps a dispatcher `block` result onto the SDK
 * hook shape.
 *
 * Contract: a denied tool must NOT kill the turn. `continue: false` ends the
 * agent loop right after the hook, so every recoverable block (prerequisite,
 * permission mode, source activation, arg validation, oversized image) has to
 * come back as `permissionDecision: 'deny'` with `continue: true`, leaving the
 * model alive to read the reason and correct course. Only an explicit user
 * denial at a permission prompt ends the turn, and even then it carries a
 * `stopReason` so the UI has something to show.
 *
 * The `[ERROR]` marker rides inside `permissionDecisionReason`: real errors
 * keep it (the model must read a failure), control-flow blocks must not get it
 * — notably the successful mid-turn source activation, where the marker would
 * tell the model the activation failed.
 *
 * A pending steer message (the user typing mid-turn) rides on the same hook
 * output as `additionalContext`. It is deliverable on every outcome that keeps
 * the turn alive — including a deny — and must NOT be attached to the turn-
 * ending denial, where the agent loop stops before reading it: leaving it
 * pending is what lets chatImpl emit `steer_undelivered` and re-queue it.
 */
import { describe, it, expect } from 'bun:test';
import { canDeliverSteer, encodeClaudeToolBlock } from '../claude-agent.ts';

describe('encodeClaudeToolBlock', () => {
  it('keeps the turn alive when a prerequisite blocks a tool', () => {
    // The literal production regression: mcp__session__browser_tool blocked by
    // the strict PrerequisiteManager killed the whole turn.
    const encoded = encodeClaudeToolBlock({
      reason: 'mcp__session__browser_tool requires reading /docs/browser-tools.md first.',
      isError: true,
    });
    expect(encoded.continue).toBe(true);
    expect(encoded).not.toHaveProperty('decision');
    expect(encoded).not.toHaveProperty('stopReason');
  });

  it('encodes a real error block as a deny that keeps the [ERROR] marker', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Blocked in safe mode', isError: true });
    expect(encoded).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '[ERROR] Blocked in safe mode',
      },
    });
  });

  it('does NOT add [ERROR] for the successful-activation control-flow block', () => {
    const reason =
      'STOP. Source "x" has been activated successfully. The tools will be available on the next turn.';
    const encoded = encodeClaudeToolBlock({ reason, isError: false });
    expect(encoded).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
  });

  it('treats an unmarked block as control-flow (no [ERROR]) and keeps the turn alive', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'No permission handler available.' });
    expect(encoded).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'No permission handler available.',
      },
    });
  });

  it('ends the turn with a stopReason only when the user denied the prompt', () => {
    const reason = 'Permission denied by user.';
    const encoded = encodeClaudeToolBlock({ reason, endTurn: true });
    expect(encoded).toEqual({
      continue: false,
      decision: 'block',
      reason,
      stopReason: reason,
    });
  });

  it('keeps the [ERROR] marker on a turn-ending error block', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Denied', isError: true, endTurn: true });
    expect(encoded).toEqual({
      continue: false,
      decision: 'block',
      reason: '[ERROR] Denied',
      stopReason: '[ERROR] Denied',
    });
  });
});

describe('encodeClaudeToolBlock steer propagation', () => {
  const steer = 'The user just sent a new message: switch to the other file.';

  it('carries a pending steer as additionalContext on an error deny', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Blocked in safe mode', isError: true }, steer);
    expect(encoded).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '[ERROR] Blocked in safe mode',
        additionalContext: steer,
      },
    });
  });

  it('carries a pending steer as additionalContext on a control-flow deny', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Source activated.' }, steer);
    expect(encoded).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Source activated.',
        additionalContext: steer,
      },
    });
  });

  it('omits additionalContext when there is no pending steer', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Blocked in safe mode', isError: true });
    expect(encoded).not.toHaveProperty('hookSpecificOutput.additionalContext');
  });

  it('never attaches a steer to the turn-ending denial', () => {
    const reason = 'Permission denied by user.';
    const encoded = encodeClaudeToolBlock({ reason, endTurn: true }, steer);
    expect(encoded).toEqual({
      continue: false,
      decision: 'block',
      reason,
      stopReason: reason,
    });
  });
});

describe('canDeliverSteer', () => {
  it('delivers on every outcome that keeps the turn alive', () => {
    expect(canDeliverSteer({ type: 'allow' })).toBe(true);
    expect(canDeliverSteer({ type: 'modify', input: {} })).toBe(true);
    expect(canDeliverSteer({ type: 'passthrough' })).toBe(true);
    expect(canDeliverSteer({ type: 'block', reason: 'Prerequisite missing', isError: true })).toBe(true);
  });

  it('does not deliver on the turn-ending denial, so the steer stays pending', () => {
    expect(
      canDeliverSteer({ type: 'block', reason: 'Permission denied by user.', endTurn: true }),
    ).toBe(false);
  });
});
