import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { MemoryStore } from '../memory-store.ts';
import { MemoryContextBuilder } from '../memory-context-builder.ts';
import { ObservationPipeline } from '../observation-pipeline.ts';

describe('Memory Service Integration', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  it('full lifecycle: upsert → search → context → delete', async () => {
    const { memory } = await store.upsert({
      target: 'user',
      category: 'profile',
      content: 'User prefers Vim keybindings in all editors',
      tags: ['editor', 'preferences'],
    });

    const searchResults = store.searchFTS('Vim');
    expect(searchResults.length).toBe(1);
    expect(searchResults[0]!.memory.id).toBe(memory.id);
    expect(searchResults[0]!.salienceScore).toBeGreaterThan(0);

    const builder = new MemoryContextBuilder(store);
    const ctx = builder.buildContext({ availableTokens: 200_000 });
    expect(ctx.content).toContain('Vim');

    expect(store.delete(memory.id)).toBe(true);
    expect(store.count().total).toBe(0);
  });

  it('dedup reinforces instead of duplicating', async () => {
    await store.upsert({ target: 'user', category: 'profile', content: 'Prefers dark mode' });
    await store.upsert({ target: 'user', category: 'profile', content: 'Prefers dark mode' });
    await store.upsert({ target: 'user', category: 'profile', content: 'Prefers dark mode' });

    const counts = store.count();
    expect(counts.total).toBe(1);

    const memories = store.getByTarget('user');
    expect(memories[0]!.reinforcementCount).toBe(3);
  });

  it('observation pipeline integrates with store', async () => {
    const queryFn = async () => JSON.stringify([
      { target: 'user', category: 'profile', content: 'Uses React for frontend', tags: ['react'] },
      { target: 'agent', category: 'knowledge', content: 'Project uses monorepo', tags: ['architecture'] },
    ]);

    const pipeline = new ObservationPipeline(store, queryFn);
    const memories = await pipeline.processAssistantTurn({
      sessionId: 'test-session',
      turnId: 'test-turn-1',
      userMessage: 'Tell me about the project',
      assistantResponse: 'This project uses React in a monorepo',
    });

    expect(memories.length).toBe(2);
    expect(store.count().total).toBe(2);

    const reprocessed = await pipeline.processAssistantTurn({
      sessionId: 'test-session',
      turnId: 'test-turn-1',
      userMessage: 'Tell me about the project',
      assistantResponse: 'This project uses React in a monorepo',
    });
    expect(reprocessed).toEqual([]);
  });

  it('context builder adapts disclosure level to budget', async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsert({
        target: 'user', category: 'profile', content: `User preference ${i}: likes feature ${i}`,
      });
    }

    const builder = new MemoryContextBuilder(store);

    const compact = builder.buildContext({ availableTokens: 1000 });
    expect(compact.level).toBe('compact');
    expect(compact.tokenEstimate).toBeLessThan(80);

    const timeline = builder.buildContext({ availableTokens: 5000 });
    expect(timeline.level).toBe('timeline');

    const full = builder.buildContext({ availableTokens: 200_000 });
    expect(full.level).toBe('full');
    expect(full.tokenEstimate).toBeGreaterThan(compact.tokenEstimate);
  });

  it('concurrent upserts are safe', async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      store.upsert({
        target: 'agent',
        category: 'knowledge',
        content: `Concurrent fact ${i}`,
      })
    );

    const results = await Promise.all(promises);
    expect(results.length).toBe(20);
    expect(store.count().total).toBe(20);
  });

  it('feature flag off means empty context', () => {
    const builder = new MemoryContextBuilder(store);
    const ctx = builder.buildContext({ availableTokens: 200_000 });
    expect(ctx.content).toBe('');
  });
});
