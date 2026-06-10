/**
 * Tests for estimateTokensDensityAware — base64-density correction that guards
 * against session poisoning from token-dense tool results (v0.9.3 fix, #862-class).
 *
 * Scoped to the density heuristic (the part ported into this fork); the upstream
 * model-aware `tokenLimitFor` path is not present here.
 */

import { describe, test, expect } from 'bun:test';
import { estimateTokens, estimateTokensDensityAware, TOKEN_LIMIT } from '../large-response.ts';

describe('estimateTokensDensityAware', () => {
  test('matches estimateTokens for short inputs', () => {
    const text = 'a'.repeat(10_000);
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });

  test('matches estimateTokens for long natural-language inputs', () => {
    // English-ish text with spaces, punctuation, line breaks — no long
    // unbroken base64 runs, so the heuristic should not fire.
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    const text = sentence.repeat(800); // ~36KB of normal prose
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });

  test('escalates estimate for base64-heavy text over 20KB', () => {
    // 30KB of unbroken base64 chars — should trip the density correction.
    const base64 = 'A'.repeat(30_000);
    const dense = estimateTokensDensityAware(base64);
    expect(dense).toBeGreaterThan(estimateTokens(base64));
    // 30_000 / 1.5 = 20_000.
    expect(dense).toBe(20_000);
  });

  test('escalates estimate for RFC 2045 MIME base64 (76-char line wrapping)', () => {
    // MIME wraps base64 at 76 chars with \r\n separators. Each line is one
    // 76-char run between separators — well above the 60-char minimum, so
    // density correction must fire on bodies that are mostly such lines.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push('X'.repeat(76)); // ~30KB body
    const text = lines.join('\r\n');
    const dense = estimateTokensDensityAware(text);
    expect(dense).toBeGreaterThan(estimateTokens(text));
  });

  test('escalates estimate for PEM-style base64 (64-char line wrapping)', () => {
    // PEM wraps at 64 chars — also above the 60-char minimum.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push('X'.repeat(64)); // ~32KB body
    const text = lines.join('\n');
    const dense = estimateTokensDensityAware(text);
    expect(dense).toBeGreaterThan(estimateTokens(text));
  });

  test('does not escalate when base64-like runs are sparse', () => {
    // Sparse short identifiers in mostly natural text — no individual run
    // long enough to count.
    const text =
      ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'See https://example.com/abc123 for details. ').repeat(400);
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });

  test('TOKEN_LIMIT lowered to 12k for poisoning headroom', () => {
    expect(TOKEN_LIMIT).toBe(12_000);
  });
});
