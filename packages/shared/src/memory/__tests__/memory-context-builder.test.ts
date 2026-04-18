import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { MemoryContextBuilder } from '../memory-context-builder.ts';
import { MemoryStore } from '../memory-store.ts';

describe('MemoryContextBuilder', () => {
  let store: MemoryStore;
  let builder: MemoryContextBuilder;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    store.initialize();
    builder = new MemoryContextBuilder(store);
  });

  afterEach(() => {
    store.close();
  });

  describe('buildContext', () => {
    it('returns empty content when no memories', () => {
      const ctx = builder.buildContext({ availableTokens: 200_000 });
      expect(ctx.content).toBe('');
    });

    it('returns compact level for small budget', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Test memory' });
      const ctx = builder.buildContext({ availableTokens: 1000 });
      expect(ctx.level).toBe('compact');
    });

    it('returns timeline level for medium budget', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Test memory' });
      const ctx = builder.buildContext({ availableTokens: 5000 });
      expect(ctx.level).toBe('timeline');
    });

    it('returns full level for large budget', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Test memory' });
      const ctx = builder.buildContext({ availableTokens: 200_000 });
      expect(ctx.level).toBe('full');
    });

    it('includes token estimate', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'User prefers dark mode' });
      const ctx = builder.buildContext({ availableTokens: 200_000 });
      expect(ctx.tokenEstimate).toBeGreaterThan(0);
    });
  });

  describe('buildCompactIndex', () => {
    it('returns empty string when no memories', () => {
      expect(builder.buildCompactIndex()).toBe('');
    });

    it('includes counts', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Fact 1' });
      await store.upsert({ target: 'agent', category: 'knowledge', content: 'Fact 2' });

      const index = builder.buildCompactIndex();
      expect(index).toContain('2 entries');
      expect(index).toContain('1 user');
      expect(index).toContain('1 agent');
    });
  });

  describe('buildTimeline', () => {
    it('returns empty string when no memories', () => {
      expect(builder.buildTimeline()).toBe('');
    });

    it('includes memory previews', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'User likes TypeScript' });

      const timeline = builder.buildTimeline();
      expect(timeline).toContain('TypeScript');
      expect(timeline).toContain('Profile');
    });

    it('limits to top 10 by salience', async () => {
      for (let i = 0; i < 15; i++) {
        await store.upsert({ target: 'agent', category: 'knowledge', content: `Fact number ${i}` });
      }

      const timeline = builder.buildTimeline();
      const lines = timeline.split('\n').filter(l => l.startsWith('-'));
      expect(lines.length).toBeLessThanOrEqual(10);
    });
  });

  describe('buildFullDetails', () => {
    it('groups by target and category', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Name is João' });
      await store.upsert({ target: 'agent', category: 'knowledge', content: 'Uses Bun runtime' });

      const full = builder.buildFullDetails();
      expect(full).toContain('User Profile');
      expect(full).toContain('Agent Notes');
      expect(full).toContain('João');
      expect(full).toContain('Bun');
    });

    it('uses search results when query provided', async () => {
      await store.upsert({ target: 'user', category: 'profile', content: 'Prefers dark mode and TypeScript' });
      await store.upsert({ target: 'agent', category: 'knowledge', content: 'Database is PostgreSQL' });

      const full = builder.buildFullDetails('TypeScript');
      expect(full).toContain('TypeScript');
    });
  });
});
