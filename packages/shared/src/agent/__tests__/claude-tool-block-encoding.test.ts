/**
 * The Claude PreToolUse encoder maps a dispatcher `block` result onto the SDK
 * hook shape. Real errors carry the `[ERROR]` marker (so the model reads a
 * failure); control-flow blocks — notably the successful mid-turn source
 * activation that asks the user to resend — must NOT, or the model would think
 * the activation failed. Regression guard for the [ALTO] bug where every block
 * was routed through blockWithReason and picked up a spurious `[ERROR]`.
 */
import { describe, it, expect } from 'bun:test';
import { encodeClaudeToolBlock } from '../claude-agent.ts';

describe('encodeClaudeToolBlock', () => {
  it('adds the [ERROR] marker for a real error block', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Blocked in safe mode', isError: true });
    expect(encoded).toEqual({
      continue: false,
      decision: 'block',
      reason: '[ERROR] Blocked in safe mode',
    });
  });

  it('does NOT add [ERROR] for the successful-activation control-flow block', () => {
    const reason =
      'STOP. Source "x" has been activated successfully. The tools will be available on the next turn.';
    const encoded = encodeClaudeToolBlock({ reason, isError: false });
    expect(encoded).toEqual({ continue: false, decision: 'block', reason });
    expect(encoded.reason.startsWith('[ERROR]')).toBe(false);
  });

  it('treats an unmarked block as control-flow (no [ERROR])', () => {
    const encoded = encodeClaudeToolBlock({ reason: 'Permission denied by user.' });
    expect(encoded.reason).toBe('Permission denied by user.');
    expect(encoded.reason.startsWith('[ERROR]')).toBe(false);
  });
});
