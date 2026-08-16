import { join } from 'node:path';
import type { WorkspaceObjectEvent } from '@craft-agent/shared/workspace-objects/types';
import {
  WORKSPACE_OBJECT_WATCH_ALL,
  WorkspaceObjectWatcherRegistry,
  type WatchFactory,
} from './workspace-object-watcher';

export interface WorkspaceObjectFeedSubscription {
  clientId: string;
  workspaceId: string;
  workspaceRootPath: string;
  deliver: (event: WorkspaceObjectEvent) => void;
  reload: () => void;
}

export interface WorkspaceObjectEventFeedOptions {
  readEventProjection: (path: string) => WorkspaceObjectEvent | null;
  reconcile: (workspaceId: string, workspaceRootPath: string, changedPath: string) => void;
  watch?: WatchFactory;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

interface ClientState {
  deliver: (event: WorkspaceObjectEvent) => void;
  reload: () => void;
  seen: Map<string, { revision: number; statuses: Set<WorkspaceObjectEvent['projectionStatus']> }>;
}

export class WorkspaceObjectEventFeed {
  private readonly registry: WorkspaceObjectWatcherRegistry;
  private readonly clientsByWorkspace = new Map<string, Map<string, ClientState>>();

  constructor(private readonly options: WorkspaceObjectEventFeedOptions) {
    this.registry = new WorkspaceObjectWatcherRegistry({
      watch: options.watch,
      debounceMs: options.debounceMs,
    });
  }

  get activeWatcherCount(): number { return this.registry.activeWatcherCount; }

  subscribe(subscription: WorkspaceObjectFeedSubscription): void {
    const { clientId, workspaceId, workspaceRootPath } = subscription;
    let clients = this.clientsByWorkspace.get(workspaceId);
    if (!clients) {
      clients = new Map();
      this.clientsByWorkspace.set(workspaceId, clients);
    }
    clients.set(clientId, { deliver: subscription.deliver, reload: subscription.reload, seen: new Map() });
    this.registry.subscribe(
      clientId,
      workspaceId,
      workspaceRootPath,
      changedPath => this.onClientWatchEvent(workspaceId, workspaceRootPath, clientId, changedPath),
      changedPath => this.options.reconcile(workspaceId, workspaceRootPath, changedPath),
    );
  }

  unsubscribe(clientId: string, workspaceId: string): void {
    const clients = this.clientsByWorkspace.get(workspaceId);
    if (clients) {
      clients.delete(clientId);
      if (clients.size === 0) this.clientsByWorkspace.delete(workspaceId);
    }
    this.registry.unsubscribe(clientId, workspaceId);
  }

  unsubscribeClient(clientId: string): void {
    for (const workspaceId of [...this.clientsByWorkspace.keys()]) this.unsubscribe(clientId, workspaceId);
    this.registry.unsubscribeClient(clientId);
  }

  publishLocal(workspaceId: string, event: WorkspaceObjectEvent): void {
    const clients = this.clientsByWorkspace.get(workspaceId);
    if (!clients) return;
    const scoped = event.workspaceId === workspaceId ? event : { ...event, workspaceId };
    // Deliver to each client in isolation: a throwing client must not block its
    // siblings, and its unrecorded revision lets a later publish retry delivery.
    for (const client of clients.values()) {
      try {
        this.deliverToClient(client, scoped);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  closeAll(): void {
    this.clientsByWorkspace.clear();
    this.registry.closeAll();
  }

  private onClientWatchEvent(workspaceId: string, workspaceRootPath: string, clientId: string, changedPath: string): void {
    const client = this.clientsByWorkspace.get(workspaceId)?.get(clientId);
    if (!client) return;
    if (changedPath === WORKSPACE_OBJECT_WATCH_ALL) { client.reload(); return; }
    if (!changedPath.startsWith('.events/') || !changedPath.endsWith('.json')) return;
    try {
      const event = this.options.readEventProjection(join(workspaceRootPath, 'objects', changedPath));
      if (event) this.deliverToClient(client, event.workspaceId === workspaceId ? event : { ...event, workspaceId });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private deliverToClient(client: ClientState, event: WorkspaceObjectEvent): void {
    const seen = client.seen.get(event.objectId);
    if (seen) {
      if (event.revision < seen.revision) return;
      if (event.revision === seen.revision && seen.statuses.has(event.projectionStatus)) return;
    }
    // Record the revision/status only after a successful delivery so a throwing
    // client is retried on the next publish instead of being silently deduped.
    client.deliver(event);
    if (!seen || event.revision > seen.revision) {
      client.seen.set(event.objectId, { revision: event.revision, statuses: new Set([event.projectionStatus]) });
    } else {
      seen.statuses.add(event.projectionStatus);
    }
  }
}
