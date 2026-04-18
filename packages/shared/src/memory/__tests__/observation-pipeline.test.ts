import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { ObservationPipeline } from '../observation-pipeline.ts';
import { MemoryStore } from '../memory-store.ts';

describe('ObservationPipeline', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  describe('processAssistantTurn', () => {
    it('skips already processed turns', async () => {
      let callCount = 0;
      const queryFn = async () => { callCount++; return '[]'; };

      const pipeline = new ObservationPipeline(store, queryFn);
      store.markTurnProcessed('turn-1');

      const result = await pipeline.processAssistantTurn({
        sessionId: 'session-1', turnId: 'turn-1',
        userMessage: 'hello', assistantResponse: 'hi',
      });

      expect(result).toEqual([]);
      expect(callCount).toBe(0);
    });

    it('returns empty when no queryFn', async () => {
      const pipeline = new ObservationPipeline(store);
      const result = await pipeline.processAssistantTurn({
        sessionId: 's1', turnId: 't1', userMessage: 'hello', assistantResponse: 'hi',
      });
      expect(result).toEqual([]);
    });

    it('extracts and stores memories from LLM response', async () => {
      const queryFn = async () => JSON.stringify([
        { target: 'user', category: 'profile', content: 'User likes dark mode', tags: ['preferences'] },
      ]);

      const pipeline = new ObservationPipeline(store, queryFn);
      const result = await pipeline.processAssistantTurn({
        sessionId: 's1', turnId: 't1',
        userMessage: 'I prefer dark mode', assistantResponse: 'Noted!',
      });

      expect(result.length).toBe(1);
      expect(result[0]!.content).toBe('User likes dark mode');
      expect(store.count().total).toBe(1);
    });

    it('marks turn as processed after extraction', async () => {
      const queryFn = async () => '[]';
      const pipeline = new ObservationPipeline(store, queryFn);

      await pipeline.processAssistantTurn({
        sessionId: 's1', turnId: 't1', userMessage: 'hello', assistantResponse: 'hi',
      });

      expect(store.hasTurnBeenProcessed('t1')).toBe(true);
    });
  });

  describe('parseExtractedMemories', () => {
    it('parses valid JSON array', () => {
      const pipeline = new ObservationPipeline(store);
      const result = pipeline.parseExtractedMemories(JSON.stringify([
        { target: 'user', category: 'profile', content: 'Test', tags: [] },
      ]));
      expect(result.length).toBe(1);
    });

    it('handles JSON embedded in text', () => {
      const pipeline = new ObservationPipeline(store);
      const result = pipeline.parseExtractedMemories(
        'Here are the memories: [{"target":"user","category":"profile","content":"Test","tags":[]}]'
      );
      expect(result.length).toBe(1);
    });

    it('filters invalid entries', () => {
      const pipeline = new ObservationPipeline(store);
      const result = pipeline.parseExtractedMemories(JSON.stringify([
        { target: 'user', category: 'profile', content: 'Valid', tags: [] },
        { target: 'invalid', category: 'profile', content: 'Invalid target', tags: [] },
        { category: 'profile', content: 'Missing target', tags: [] },
      ]));
      expect(result.length).toBe(1);
    });

    it('returns empty for invalid JSON', () => {
      const pipeline = new ObservationPipeline(store);
      expect(pipeline.parseExtractedMemories('not json')).toEqual([]);
    });

    it('returns empty for non-array JSON', () => {
      const pipeline = new ObservationPipeline(store);
      expect(pipeline.parseExtractedMemories('{"key": "value"}')).toEqual([]);
    });
  });

  describe('buildExtractionPrompt', () => {
    it('includes user message and assistant response', () => {
      const pipeline = new ObservationPipeline(store);
      const prompt = pipeline.buildExtractionPrompt('Hello', 'Hi there');
      expect(prompt).toContain('Hello');
      expect(prompt).toContain('Hi there');
    });

    it('includes tool names when provided', () => {
      const pipeline = new ObservationPipeline(store);
      const prompt = pipeline.buildExtractionPrompt('msg', 'resp', [
        { name: 'read_file', input: {}, output: {} },
      ]);
      expect(prompt).toContain('read_file');
    });

    it('truncates long messages', () => {
      const pipeline = new ObservationPipeline(store);
      const longMsg = 'a'.repeat(1000);
      const prompt = pipeline.buildExtractionPrompt(longMsg, 'resp');
      expect(prompt.length).toBeLessThan(longMsg.length + 500);
    });
  });
});
