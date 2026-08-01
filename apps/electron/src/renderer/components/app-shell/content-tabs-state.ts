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
  | { type: 'restore'; state: ContentTabsState };

function normalizeTarget(target: ContentTarget): ContentTarget {
  if (target.kind === 'object') return target;
  const parts: string[] = [];
  for (const part of target.path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  const prefix = target.path.startsWith('/') ? '/' : '';
  const normalized = `${prefix}${parts.join('/')}`;
  return { ...target, path: normalized };
}

export function contentTabId(rawTarget: ContentTarget): string {
  const target = normalizeTarget(rawTarget);
  return target.kind === 'file'
    ? `file:${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.sessionId)}:${encodeURIComponent(target.path)}`
    : `object:${encodeURIComponent(target.workspaceId)}:${encodeURIComponent(target.objectId)}:${encodeURIComponent(target.viewId ?? '')}`;
}

function previewScope(target: ContentTarget): string {
  return target.kind === 'file' ? `file:${target.workspaceId}:${target.sessionId}` : `object:${target.workspaceId}`;
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
    if (existing) return { tabs: state.tabs, activeId: id };
    const retained = action.mode === 'preview'
      ? state.tabs.filter(tab => tab.mode !== 'preview' || tab.pinned || previewScope(tab.target) !== previewScope(target))
      : state.tabs;
    return { tabs: [...retained, { id, target, mode: action.mode, pinned: false }], activeId: id };
  }
  if (action.type === 'select') return repairActive(state.tabs, action.id);
  if (action.type === 'close') return repairActive(state.tabs.filter(tab => tab.id !== action.id), state.activeId === action.id ? null : state.activeId);
  const tabs = state.tabs.map(tab => tab.id === action.id
    ? action.type === 'pin' ? { ...tab, pinned: true, mode: 'permanent' as const } : { ...tab, mode: 'permanent' as const }
    : tab);
  return repairActive(tabs, state.activeId);
}

export function restoreContentTabs(value: ContentTabsState, workspaceId: string, sessionId: string): ContentTabsState {
  const tabs: ContentTab[] = [];
  for (const tab of value.tabs) {
    if (tab.target.workspaceId !== workspaceId) continue;
    if (tab.target.kind === 'file' && tab.target.sessionId !== sessionId) continue;
    tabs.push({ ...tab, target: normalizeTarget(tab.target), id: contentTabId(tab.target) });
  }
  return repairActive(tabs, value.activeId);
}
