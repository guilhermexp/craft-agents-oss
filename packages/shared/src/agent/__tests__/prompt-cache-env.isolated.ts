/**
 * buildClaudeSubprocessEnv — extendedPromptCache → native CLI env switches.
 *
 * The native Claude binary gates 1h prompt-cache TTL behind
 * ENABLE_PROMPT_CACHING_1H / FORCE_PROMPT_CACHING_5M (the old interceptor
 * patched cache_control directly, but it can't be preloaded into the native
 * binary). These tests pin the env wiring.
 *
 * Isolated: mock.module replaces preference-storage for the whole process.
 */

import { describe, test, expect, mock } from 'bun:test';
import * as realPreferenceStorage from '../../config/preference-storage.ts';

let extendedPromptCache = false;
mock.module('../../config/preference-storage.ts', () => ({
  ...realPreferenceStorage,
  getExtendedPromptCache: () => extendedPromptCache,
}));

const { buildClaudeSubprocessEnv } = await import('../options.ts');

describe('buildClaudeSubprocessEnv prompt cache TTL', () => {
  test('preference disabled → forces 5m TTL', () => {
    extendedPromptCache = false;
    const env = buildClaudeSubprocessEnv();
    expect(env.FORCE_PROMPT_CACHING_5M).toBe('1');
    expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
  });

  test('preference enabled → enables 1h TTL', () => {
    extendedPromptCache = true;
    const env = buildClaudeSubprocessEnv();
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe('1');
    expect(env.FORCE_PROMPT_CACHING_5M).toBeUndefined();
  });

  test('explicit user override wins over the preference', () => {
    extendedPromptCache = true;
    const env = buildClaudeSubprocessEnv({ FORCE_PROMPT_CACHING_5M: 'true' });
    expect(env.FORCE_PROMPT_CACHING_5M).toBe('true');
    expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
  });
});
