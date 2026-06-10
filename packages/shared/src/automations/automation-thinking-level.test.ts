/**
 * Tests for the per-automation thinkingLevel override (v0.8.13).
 *
 * Locks the schema contract added to PromptActionSchema: accept valid levels,
 * reject unknown ones, migrate the legacy 'think' alias to 'medium', and stay
 * backward-compatible when omitted. Exercised through the public
 * validateAutomationsConfig entry point (PromptActionSchema is module-private).
 */

import { describe, it, expect } from 'bun:test';
import { validateAutomationsConfig } from './validation.ts';
import { PromptActionSchema } from './schemas.ts';

function promptConfig(action: Record<string, unknown>) {
  return {
    automations: {
      SchedulerTick: [{ cron: '0 9 * * *', actions: [action] }],
    },
  };
}

function firstAction(result: ReturnType<typeof validateAutomationsConfig>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const automations = result.config?.automations as any;
  return automations?.SchedulerTick?.[0]?.actions?.[0];
}

describe('automation prompt action — thinkingLevel', () => {
  it('accepts a valid thinkingLevel', () => {
    const result = validateAutomationsConfig(
      promptConfig({ type: 'prompt', prompt: 'Audit changes', thinkingLevel: 'high' }),
    );
    expect(result.valid).toBe(true);
    expect(firstAction(result)).toMatchObject({ thinkingLevel: 'high' });
  });

  it('PromptActionSchema rejects an unknown thinkingLevel value', () => {
    // Tested against PromptActionSchema directly: the config-level action union
    // has a permissive passthrough fallback, so an invalid level survives there
    // unmigrated rather than failing the whole config. The schema's own contract
    // is the strict one.
    const result = PromptActionSchema.safeParse({ type: 'prompt', prompt: 'echo', thinkingLevel: 'extreme' });
    expect(result.success).toBe(false);
  });

  it("migrates the legacy 'think' alias to 'medium'", () => {
    const result = validateAutomationsConfig(
      promptConfig({ type: 'prompt', prompt: 'echo', thinkingLevel: 'think' }),
    );
    expect(result.valid).toBe(true);
    expect(firstAction(result)).toMatchObject({ thinkingLevel: 'medium' });
  });

  it('accepts a prompt action without thinkingLevel (backward compat)', () => {
    const result = validateAutomationsConfig(
      promptConfig({ type: 'prompt', prompt: 'echo' }),
    );
    expect(result.valid).toBe(true);
    expect(firstAction(result)).toEqual({ type: 'prompt', prompt: 'echo' });
  });
});
