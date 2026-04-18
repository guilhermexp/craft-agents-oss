import { describe, expect, it } from 'bun:test';
import { normalizeContent, computeContentHash } from '../deduplication.ts';

describe('normalizeContent', () => {
  it('trims whitespace', () => {
    expect(normalizeContent('  hello  ')).toBe('hello');
  });

  it('lowercases', () => {
    expect(normalizeContent('Hello World')).toBe('hello world');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeContent('hello   world')).toBe('hello world');
  });

  it('handles newlines and tabs', () => {
    expect(normalizeContent('hello\n\tworld')).toBe('hello world');
  });
});

describe('computeContentHash', () => {
  it('produces consistent hashes', async () => {
    const hash1 = await computeContentHash('test content', 'user');
    const hash2 = await computeContentHash('test content', 'user');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different content', async () => {
    const hash1 = await computeContentHash('content A', 'user');
    const hash2 = await computeContentHash('content B', 'user');
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different targets', async () => {
    const hash1 = await computeContentHash('same content', 'user');
    const hash2 = await computeContentHash('same content', 'agent');
    expect(hash1).not.toBe(hash2);
  });

  it('normalizes before hashing', async () => {
    const hash1 = await computeContentHash('  Hello  World  ', 'user');
    const hash2 = await computeContentHash('hello world', 'user');
    expect(hash1).toBe(hash2);
  });

  it('returns 32-char hex string', async () => {
    const hash = await computeContentHash('test', 'user');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
