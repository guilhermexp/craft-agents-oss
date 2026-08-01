import { describe, expect, test } from 'bun:test';
import { ContentResolver } from '../content-resolver.ts';

const target = (id: number) => ({ kind: 'object' as const, workspaceId: 'w1', objectId: `o${id}` });

describe('ContentResolver', () => {
  test('evicts the actual least-recent payload after the twentieth entry', async () => {
    const resolver = new ContentResolver<number>(20);
    for (let index = 0; index < 21; index += 1) await resolver.load(target(index), async () => index);
    expect(resolver.payloadCount).toBe(20);
    expect(resolver.peek(target(0))).toBeUndefined();
    expect(resolver.peek(target(20))).toBe(20);
  });

  test('shares cancellation/generation for load and refresh and preserves stale payload', async () => {
    const resolver = new ContentResolver<string>(20);
    await resolver.load(target(1), async () => 'old');
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: string) => void) | undefined;
    const refresh = resolver.refresh(target(1), signal => {
      firstSignal = signal;
      return new Promise(resolve => { resolveFirst = resolve; });
    });
    expect(refresh.current).toBe('old');
    const newest = resolver.refresh(target(1), async () => 'new');
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.('stale');
    await Promise.all([refresh.promise, newest.promise]);
    expect(resolver.peek(target(1))).toBe('new');
    resolver.dispose();
  });
});
