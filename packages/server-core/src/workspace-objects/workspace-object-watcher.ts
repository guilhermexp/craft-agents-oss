import { existsSync, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export interface WatchHandle {
  close(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
export type WatchListener = (event: string, filename: string | null) => void;
export type WatchFactory = (path: string, listener: WatchListener) => WatchHandle;

export const WORKSPACE_OBJECT_WATCH_ALL = '*';

interface RegistryOptions {
  watch?: WatchFactory;
  debounceMs?: number;
}

interface WorkspaceWatch {
  handle: WatchHandle | null;
  objectsPath: string;
  subscribers: Map<string, (path: string) => void>;
  reconcile: (path: string) => void;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  recovering: boolean;
}

function shouldIgnore(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').pop() ?? '';
  return name === 'objects.sqlite'
    || name.startsWith('objects.sqlite-')
    || name.endsWith('-wal')
    || name.endsWith('-shm')
    || name.endsWith('.tmp')
    || name.startsWith('.tmp-');
}

export class WorkspaceObjectWatcherRegistry {
  private readonly watches = new Map<string, WorkspaceWatch>();
  private readonly watchFactory: WatchFactory;
  private readonly debounceMs: number;

  constructor(options: RegistryOptions = {}) {
    this.watchFactory = options.watch ?? ((path, listener) => fsWatch(path, { recursive: true }, listener) as FSWatcher);
    this.debounceMs = options.debounceMs ?? 120;
  }

  get activeWatcherCount(): number { return this.watches.size; }

  private schedule(entry: WorkspaceWatch, rawPath: string): void {
    const normalized = rawPath.replaceAll('\\', '/');
    clearTimeout(entry.timers.get(normalized));
    entry.timers.set(normalized, setTimeout(() => {
      entry.timers.delete(normalized);
      entry.reconcile(normalized);
      for (const subscriber of entry.subscribers.values()) subscriber(normalized);
    }, this.debounceMs));
  }

  private arm(workspaceId: string, entry: WorkspaceWatch): void {
    const handle = this.watchFactory(entry.objectsPath, (_event, filename) => {
      if (filename && shouldIgnore(filename)) return;
      this.schedule(entry, filename ?? WORKSPACE_OBJECT_WATCH_ALL);
    });
    entry.handle = handle;
    handle.on?.('error', () => this.recoverWorkspace(workspaceId, entry, handle));
  }

  private recoverWorkspace(workspaceId: string, entry: WorkspaceWatch, handle: WatchHandle): void {
    // Ignore error callbacks from a handle we already replaced or removed.
    if (this.watches.get(workspaceId) !== entry || entry.handle !== handle) return;
    // Guard against a synchronous re-arm error looping back into recovery.
    if (entry.recovering) return;
    entry.recovering = true;
    try {
      try { entry.handle?.close(); } catch { /* The watcher is already unusable. */ }
      entry.handle = null;
      for (const timer of entry.timers.values()) clearTimeout(timer);
      entry.timers.clear();
      try { entry.reconcile(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* Keep notifying remaining subscribers. */ }
      for (const subscriber of entry.subscribers.values()) {
        try { subscriber(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* A client callback must not escape an fs error. */ }
      }
      // Nothing left to watch — drop the entry so teardown stays refcounted.
      if (entry.subscribers.size === 0) {
        this.watches.delete(workspaceId);
        return;
      }
      // Re-arm a fresh watcher for the still-active subscribers. A synchronous
      // arm failure drops the entry rather than retrying, so recovery of a
      // permanently-broken watch cannot loop.
      try {
        this.arm(workspaceId, entry);
      } catch {
        this.watches.delete(workspaceId);
      }
    } finally {
      entry.recovering = false;
    }
  }

  subscribe(
    clientId: string,
    workspaceId: string,
    workspaceRootPath: string,
    listener: (path: string) => void,
    reconcile: (path: string) => void = () => {},
  ): void {
    let entry = this.watches.get(workspaceId);
    if (!entry) {
      const objectsPath = join(workspaceRootPath, 'objects');
      if (!existsSync(objectsPath)) mkdirSync(objectsPath, { recursive: true });
      const subscribers = new Map<string, (path: string) => void>();
      subscribers.set(clientId, listener);
      entry = {
        handle: null,
        objectsPath,
        subscribers,
        reconcile,
        timers: new Map<string, ReturnType<typeof setTimeout>>(),
        recovering: false,
      };
      this.watches.set(workspaceId, entry);
      try {
        this.arm(workspaceId, entry);
      } catch {
        // Creation failed outright: there is no live watcher to re-arm, so
        // notify once for a workspace-wide reconcile and drop the entry.
        this.watches.delete(workspaceId);
        try { entry.reconcile(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* Keep notifying remaining subscribers. */ }
        for (const subscriber of entry.subscribers.values()) {
          try { subscriber(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* A client callback must not escape an fs error. */ }
        }
      }
      return;
    }
    entry.subscribers.set(clientId, listener);
  }

  unsubscribe(clientId: string, workspaceId: string): void {
    const entry = this.watches.get(workspaceId);
    if (!entry) return;
    entry.subscribers.delete(clientId);
    if (entry.subscribers.size > 0) return;
    entry.handle?.close();
    for (const timer of entry.timers.values()) clearTimeout(timer);
    entry.timers.clear();
    this.watches.delete(workspaceId);
  }

  unsubscribeClient(clientId: string): void {
    for (const workspaceId of [...this.watches.keys()]) this.unsubscribe(clientId, workspaceId);
  }

  closeAll(): void {
    for (const entry of this.watches.values()) {
      entry.handle?.close();
      for (const timer of entry.timers.values()) clearTimeout(timer);
    }
    this.watches.clear();
  }
}
