import { describe, expect, test } from 'bun:test';
import { ContentResolver } from '../content-resolver.ts';

const target = (id: number) => ({ kind: 'object' as const, workspaceId: 'w1', objectId: `o${id}` });

describe('ContentResolver', () => {
  test('shares one in-flight request across concurrent loads of the same target', async () => {
    const resolver = new ContentResolver<string>(20);
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    let resolveRequest: ((value: string) => void) | undefined;
    const loader = (signal: AbortSignal) => {
      calls += 1;
      observedSignal = signal;
      return new Promise<string>(resolve => { resolveRequest = resolve; });
    };
    const first = resolver.load(target(99), loader);
    const second = resolver.load(target(99), loader);
    expect(calls).toBe(1);
    expect(observedSignal?.aborted).toBe(false);
    resolveRequest?.('shared');
    expect(await Promise.all([first, second])).toEqual(['shared', 'shared']);
  });

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

  test('preserves stale payload and exposes an actionable refresh error', async () => {
    const resolver = new ContentResolver<string>(20);
    await resolver.load(target(2), async () => 'stale-visible');
    const refresh = resolver.refresh(target(2), async () => { throw new Error('network unavailable'); });

    expect(refresh.current).toBe('stale-visible');
    await expect(refresh.promise).rejects.toThrow('network unavailable');
    expect(resolver.peek(target(2))).toBe('stale-visible');
    expect(resolver.getError(target(2))?.message).toBe('network unavailable');
  });
});
