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
 */
import { describe, it, expect } from 'bun:test';
import { encodeClaudeToolBlock } from '../claude-agent.ts';

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
