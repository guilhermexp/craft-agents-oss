import type { WorkspaceObjectEvent } from './types.ts';

export class WorkspaceObjectEventBus {
  private readonly listeners = new Set<(event: WorkspaceObjectEvent) => void>();

  subscribe(listener: (event: WorkspaceObjectEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: WorkspaceObjectEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  clear(): void { this.listeners.clear(); }
}
