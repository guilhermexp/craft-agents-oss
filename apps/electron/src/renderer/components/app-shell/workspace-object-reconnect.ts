type WorkspaceObjectReloadListener = (workspaceId: string) => void;

const reloadListeners = new Set<WorkspaceObjectReloadListener>();

/**
 * Monotonic per-workspace ownership token. Each bind claims the next generation
 * for its workspace; a stale binding's deferred teardown must not unsubscribe a
 * newer binding that has since taken over the same workspace.
 */
const subscriptionGenerations = new Map<string, number>();

export function onWorkspaceObjectsReload(listener: WorkspaceObjectReloadListener): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

export function requestWorkspaceObjectsReload(workspaceId: string): void {
  for (const listener of reloadListeners) {
    try {
      listener(workspaceId);
    } catch (error) {
      console.error('[workspace-objects] Reload listener failed:', error);
    }
  }
}

export interface WorkspaceObjectSubscriptionApi {
  subscribeWorkspaceObjects(workspaceId: string): Promise<void>;
  unsubscribeWorkspaceObjects(workspaceId: string): Promise<void>;
  onReconnected(listener: () => void): () => void;
  onWorkspaceObjectsReloadRequest(listener: (workspaceId: string) => void): () => void;
}

export function bindWorkspaceObjectSubscription(
  api: WorkspaceObjectSubscriptionApi,
  workspaceId: string,
  onError: (error: Error) => void = error => console.error(error),
): () => void {
  const generation = (subscriptionGenerations.get(workspaceId) ?? 0) + 1;
  subscriptionGenerations.set(workspaceId, generation);
  const ownsSubscription = () => subscriptionGenerations.get(workspaceId) === generation;

  let active = true;
  let subscribeChain = Promise.resolve();
  const report = (error: unknown) => onError(error instanceof Error ? error : new Error(String(error)));
  const enqueueSubscribe = (reloadAfterSubscribe: boolean) => {
    subscribeChain = subscribeChain
      .then(() => api.subscribeWorkspaceObjects(workspaceId))
      .then(() => {
        if (reloadAfterSubscribe && active) requestWorkspaceObjectsReload(workspaceId);
      })
      .catch(report);
  };
  enqueueSubscribe(false);
  const stopReconnect = api.onReconnected(() => {
    if (active) enqueueSubscribe(true);
  });
  const stopReloadRequest = api.onWorkspaceObjectsReloadRequest(requestedWorkspaceId => {
    if (active && requestedWorkspaceId === workspaceId) requestWorkspaceObjectsReload(workspaceId);
  });
  return () => {
    active = false;
    stopReconnect();
    stopReloadRequest();
    // A newer binding for this workspace already owns the server subscription;
    // tearing it down here would unsubscribe the live binding.
    if (!ownsSubscription()) return;
    void subscribeChain
      .then(() => {
        if (!ownsSubscription()) return;
        return api.unsubscribeWorkspaceObjects(workspaceId);
      })
      .catch(report);
  };
}
