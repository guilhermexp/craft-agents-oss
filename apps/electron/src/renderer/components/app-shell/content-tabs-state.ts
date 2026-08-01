export type ContentTarget =
  | { kind: 'file'; workspaceId: string; sessionId: string; path: string }
  | { kind: 'object'; workspaceId: string; objectId: string; viewId?: string };

export interface ContentTab {
  id: string;
  target: ContentTarget;
  mode: 'preview' | 'permanent';
  pinned: boolean;
}

export interface ContentTabsState { tabs: ContentTab[]; activeId: string | null }

export type ContentTabsAction =
  | { type: 'open'; target: ContentTarget; mode: 'preview' | 'permanent' }
  | { type: 'select'; id: string }
  | { type: 'close'; id: string }
  | { type: 'promote'; id: string }
  | { type: 'pin'; id: string }
  | { type: 'retarget'; id: string; target: ContentTarget }
  | { type: 'restore'; state: ContentTabsState };

function normalizeTarget(target: ContentTarget): ContentTarget {
  if (target.kind === 'object') return target;
  const path = target.path.replaceAll('\\', '/');
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  const prefix = absolute ? '/' : '';
  const normalized = `${prefix}${parts.join('/')}`;
  return { ...target, path: normalized };
}

export function contentTabId(rawTarget: ContentTarget): string {
  const target = normalizeTarget(rawTarget);
  return target.kind === 'file'
    ? `file:${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.sessionId)}:${encodeURIComponent(target.path)}`
    : `object:${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.objectId)}:${target.viewId === undefined ? 'absent' : `present:${encodeURIComponent(target.viewId)}`}`;
}

function previewScope(target: ContentTarget): string {
  return target.kind === 'file'
    ? `file:${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.sessionId)}`
    : `object:${encodeURIComponent(target.workspaceId)}`;
}

function repairActive(tabs: ContentTab[], activeId: string | null): ContentTabsState {
  return { tabs, activeId: activeId && tabs.some(tab => tab.id === activeId) ? activeId : (tabs[0]?.id ?? null) };
}

export function contentTabsReducer(state: ContentTabsState, action: ContentTabsAction): ContentTabsState {
  if (action.type === 'restore') return repairActive(action.state.tabs, action.state.activeId);
  if (action.type === 'open') {
    const target = normalizeTarget(action.target);
    const id = contentTabId(target);
    const existing = state.tabs.find(tab => tab.id === id);
    if (existing) {
      const tabs = action.mode === 'permanent' && existing.mode !== 'permanent'
        ? state.tabs.map(tab => tab.id === id ? { ...tab, mode: 'permanent' as const } : tab)
        : state.tabs;
      return { tabs, activeId: id };
    }
    const retained = action.mode === 'preview'
      ? state.tabs.filter(tab => tab.mode !== 'preview' || tab.pinned || previewScope(tab.target) !== previewScope(target))
      : state.tabs;
    return { tabs: [...retained, { id, target, mode: action.mode, pinned: false }], activeId: id };
  }
  if (action.type === 'select') return repairActive(state.tabs, action.id);
  if (action.type === 'close') return repairActive(state.tabs.filter(tab => tab.id !== action.id), state.activeId === action.id ? null : state.activeId);
  if (action.type === 'retarget') {
    const target = normalizeTarget(action.target);
    const nextId = contentTabId(target);
    const source = state.tabs.find(tab => tab.id === action.id);
    const existing = state.tabs.find(tab => tab.id === nextId && tab.id !== action.id);
    if (source && existing) {
      const tabs = state.tabs.flatMap(tab => {
        if (tab.id === action.id) return [];
        return [tab.id === nextId ? {
          ...tab,
          pinned: tab.pinned || source.pinned,
          mode: tab.mode === 'permanent' || source.mode === 'permanent' ? 'permanent' as const : 'preview' as const,
        } : tab];
      });
      return repairActive(tabs, state.activeId === action.id ? nextId : state.activeId);
    }
    const tabs = state.tabs.map(tab => tab.id === action.id ? { ...tab, id: nextId, target } : tab);
    return repairActive(tabs, state.activeId === action.id ? nextId : state.activeId);
  }
  const tabs = state.tabs.map(tab => tab.id === action.id
    ? action.type === 'pin' ? { ...tab, pinned: true, mode: 'permanent' as const } : { ...tab, mode: 'permanent' as const }
    : tab);
  return repairActive(tabs, state.activeId);
}

function parsePersistedTab(value: unknown): ContentTab | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== 'preview' && candidate.mode !== 'permanent') return null;
  if (typeof candidate.pinned !== 'boolean' || !candidate.target || typeof candidate.target !== 'object') return null;
  const target = candidate.target as Record<string, unknown>;
  if (typeof target.workspaceId !== 'string') return null;
  let parsedTarget: ContentTarget;
  if (target.kind === 'file') {
    if (typeof target.sessionId !== 'string' || typeof target.path !== 'string') return null;
    parsedTarget = { kind: 'file', workspaceId: target.workspaceId, sessionId: target.sessionId, path: target.path };
  } else if (target.kind === 'object') {
    if (typeof target.objectId !== 'string' || (target.viewId !== undefined && typeof target.viewId !== 'string')) return null;
    parsedTarget = { kind: 'object', workspaceId: target.workspaceId, objectId: target.objectId, ...(target.viewId !== undefined ? { viewId: target.viewId } : {}) };
  } else {
    return null;
  }
  return { id: contentTabId(parsedTarget), target: normalizeTarget(parsedTarget), mode: candidate.mode, pinned: candidate.pinned };
}

export function restoreContentTabs(value: unknown, workspaceId: string, sessionId: string | null): ContentTabsState {
  if (!value || typeof value !== 'object') return { tabs: [], activeId: null };
  const persisted = value as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(persisted.tabs)) return { tabs: [], activeId: null };
  const tabs: ContentTab[] = [];
  const canonicalIds = new Set<string>();
  const persistedIdAliases = new Map<string, string>();
  for (const valueTab of persisted.tabs) {
    const tab = parsePersistedTab(valueTab);
    if (!tab) continue;
    if (tab.target.workspaceId !== workspaceId) continue;
    if (tab.target.kind === 'file' && (!sessionId || tab.target.sessionId !== sessionId)) continue;
    if (valueTab && typeof valueTab === 'object') {
      const persistedId = (valueTab as Record<string, unknown>).id;
      if (typeof persistedId === 'string' && !persistedIdAliases.has(persistedId)) persistedIdAliases.set(persistedId, tab.id);
    }
    if (canonicalIds.has(tab.id)) continue;
    canonicalIds.add(tab.id);
    tabs.push(tab);
  }
  const persistedActiveId = typeof persisted.activeId === 'string' ? persisted.activeId : null;
  const activeId = persistedActiveId
    ? (persistedIdAliases.get(persistedActiveId) ?? persistedActiveId)
    : persistedActiveId;
  return repairActive(tabs, activeId);
}
