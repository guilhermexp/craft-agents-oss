import { contentTabId, type ContentTarget } from './content-tabs-state.ts';

export type ContentLoader<T> = (signal: AbortSignal) => Promise<T>;

interface InFlight<T> {
  controller: AbortController;
  generation: number;
  promise: Promise<T | undefined>;
}

export interface ContentRefresh<T> {
  current: T | undefined;
  promise: Promise<T | undefined>;
}

export class ContentResolver<T> {
  private readonly payloads = new Map<string, T>();
  private readonly inFlight = new Map<string, InFlight<T>>();
  private readonly generations = new Map<string, number>();
  private readonly errors = new Map<string, Error>();

  constructor(private readonly capacity = 20) {
    if (capacity < 1) throw new Error('ContentResolver capacity must be positive');
  }

  get payloadCount(): number { return this.payloads.size; }

  peek(target: ContentTarget): T | undefined { return this.payloads.get(contentTabId(target)); }

  getError(target: ContentTarget): Error | undefined { return this.errors.get(contentTabId(target)); }

  async load(target: ContentTarget, loader: ContentLoader<T>): Promise<T> {
    const key = contentTabId(target);
    const existing = this.payloads.get(key);
    if (existing !== undefined) {
      this.touch(key, existing);
      return existing;
    }
    const value = await (this.inFlight.get(key)?.promise ?? this.start(key, loader));
    if (value === undefined) throw new Error(`Content load superseded for ${key}`);
    return value;
  }

  refresh(target: ContentTarget, loader: ContentLoader<T>): ContentRefresh<T> {
    const key = contentTabId(target);
    const current = this.payloads.get(key);
    if (current !== undefined) this.touch(key, current);
    return { current, promise: this.start(key, loader) };
  }

  invalidate(target: ContentTarget): void {
    const key = contentTabId(target);
    this.inFlight.get(key)?.controller.abort();
    this.inFlight.delete(key);
    this.payloads.delete(key);
    this.errors.delete(key);
    this.generations.delete(key);
  }

  dispose(): void {
    for (const request of this.inFlight.values()) request.controller.abort();
    this.inFlight.clear();
    this.payloads.clear();
    this.errors.clear();
    this.generations.clear();
  }

  private start(key: string, loader: ContentLoader<T>): Promise<T | undefined> {
    this.inFlight.get(key)?.controller.abort();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const value = await loader(controller.signal);
        if (controller.signal.aborted || this.generations.get(key) !== generation) return undefined;
        this.errors.delete(key);
        this.touch(key, value);
        this.evict();
        return value;
      } catch (error) {
        if (!controller.signal.aborted && this.generations.get(key) === generation) {
          this.errors.set(key, error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      } finally {
        if (this.inFlight.get(key)?.generation === generation) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, { controller, generation, promise });
    return promise;
  }

  private touch(key: string, value: T): void {
    this.payloads.delete(key);
    this.payloads.set(key, value);
  }

  private evict(): void {
    while (this.payloads.size > this.capacity) {
      const oldest = this.payloads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.payloads.delete(oldest);
      this.errors.delete(oldest);
      this.generations.delete(oldest);
    }
  }
}
