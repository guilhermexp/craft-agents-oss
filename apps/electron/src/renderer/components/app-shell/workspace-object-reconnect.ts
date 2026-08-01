type WorkspaceObjectReloadListener = (workspaceId: string) => void;

const reloadListeners = new Set<WorkspaceObjectReloadListener>();

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
}

export function bindWorkspaceObjectSubscription(
  api: WorkspaceObjectSubscriptionApi,
  workspaceId: string,
  onError: (error: Error) => void = error => console.error(error),
): () => void {
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
  return () => {
    active = false;
    stopReconnect();
    void subscribeChain.then(() => api.unsubscribeWorkspaceObjects(workspaceId)).catch(report);
  };
}
