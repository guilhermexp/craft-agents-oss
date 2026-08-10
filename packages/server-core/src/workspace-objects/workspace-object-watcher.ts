import { existsSync, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

interface WatchHandle {
  close(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
type WatchListener = (event: string, filename: string | null) => void;
type WatchFactory = (path: string, listener: WatchListener) => WatchHandle;

export const WORKSPACE_OBJECT_WATCH_ALL = '*';

interface RegistryOptions {
  watch?: WatchFactory;
  debounceMs?: number;
}

interface WorkspaceWatch {
  handle: WatchHandle | null;
  subscribers: Map<string, (path: string) => void>;
  reconcile: (path: string) => void;
  timers: Map<string, ReturnType<typeof setTimeout>>;
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

  private recoverWorkspace(workspaceId: string, entry: WorkspaceWatch): void {
    if (this.watches.get(workspaceId) === entry) this.watches.delete(workspaceId);
    try { entry.handle?.close(); } catch { /* The watcher is already unusable. */ }
    for (const timer of entry.timers.values()) clearTimeout(timer);
    entry.timers.clear();
    try { entry.reconcile(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* Keep notifying remaining subscribers. */ }
    for (const subscriber of entry.subscribers.values()) {
      try { subscriber(WORKSPACE_OBJECT_WATCH_ALL); } catch { /* A client callback must not escape an fs error. */ }
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
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      entry = { handle: null, subscribers, reconcile, timers };
      this.watches.set(workspaceId, entry);
      const schedule = (path: string) => {
        const normalized = path.replaceAll('\\', '/');
        const previous = timers.get(normalized);
        if (previous) clearTimeout(previous);
        timers.set(normalized, setTimeout(() => {
          timers.delete(normalized);
          entry?.reconcile(normalized);
          for (const subscriber of subscribers.values()) subscriber(normalized);
        }, this.debounceMs));
      };
      try {
        const handle = this.watchFactory(objectsPath, (_event, filename) => {
          if (filename && shouldIgnore(filename)) return;
          schedule(filename ?? WORKSPACE_OBJECT_WATCH_ALL);
        });
        entry.handle = handle;
        handle.on?.('error', () => this.recoverWorkspace(workspaceId, entry!));
      } catch {
        this.recoverWorkspace(workspaceId, entry);
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
