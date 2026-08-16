/**
 * Centralized localStorage utility for the Electron renderer.
 * Provides type-safe access with consistent key prefixing.
 */

const PREFIX = 'craft-'

/**
 * All localStorage keys used in the app.
 * Centralized here to avoid magic strings and key collisions.
 */
export const KEYS = {
  // Chat sidebar
  sidebarVisible: 'sidebar-visible',
  sidebarWidth: 'sidebar-width',
  sessionListWidth: 'session-list-width',
  sessionListVisible: 'session-list-visible',
  rightSidebarWidth: 'right-sidebar-width',
  rightSidebarPreviewWidth: 'right-sidebar-preview-width',
  sidebarMode: 'sidebar-mode',
  listFilter: 'list-filter',
  labelFilter: 'label-filter',
  viewFilters: 'view-filters', // Per-view filter map: { [viewKey]: { statuses, labels } }
  expandedFolders: 'expanded-folders',
  collapsedSidebarItems: 'collapsed-sidebar-items',
  chatGroupingMode: 'chat-grouping-mode', // How to group chats: 'date' | 'status'
  collapsedSessionGroups: 'collapsed-session-groups', // Collapsed group keys in session list

  // Focus mode
  focusModeEnabled: 'focus-mode-enabled',

  // Session files panel state
  sessionFilesExpandedFolders: 'session-files-expanded', // Expanded folders in session files tree (keyed by sessionId)
  workspaceFilesExpandedFolders: 'workspace-files-expanded', // Expanded folders in workspace files tree (keyed by root path)
  workspaceObjectTabs: 'workspace-object-tabs', // Content tabs scoped by workspace + session

  // Theme
  theme: 'theme',

  // Panel layouts (dynamic key suffix)
  panelLayout: 'panel-layout', // Used as: panelLayout:${key}

  // Tabs (workspace-scoped)
  tabs: 'tabs', // Used as: tabs-${workspaceId}

  // Working directory
  recentWorkingDirs: 'recent-working-dirs',

  // TurnCard expansion state (persisted across session switches)
  turnCardExpansion: 'turncard-expansion',

  // Last selected session (workspace-scoped via suffix)
  lastSelectedSessionId: 'last-selected-session-id',

  // Settings navigation
  lastSettingsSubpage: 'last-settings-subpage',

  // Appearance
  showConnectionIcons: 'show-connection-icons',
  projectColorTreatment: 'project-color-treatment', // 'stripe' | 'stripe-tint'

  // What's New
  whatsNewLastSeenVersion: 'whats-new-last-seen-version',

  // Workspace navigation state (workspace-scoped via suffix = workspaceSlug)
  // Stores the full URL search string so switching back restores panels/focus/sidebar
  workspaceUrl: 'workspace-url',

  // Runtime perf monitor (dev overlay)
  perfOverlayEnabled: 'perf-overlay-enabled',
} as const

export type StorageKey = typeof KEYS[keyof typeof KEYS]

/**
 * Build the full prefixed key.
 * Supports dynamic suffixes like 'panel-layout:chat' or 'tabs-workspace123'
 */
function buildKey(key: string, suffix?: string): string {
  const base = `${PREFIX}${key}`
  return suffix ? `${base}:${suffix}` : base
}

/**
 * Get a value from localStorage with JSON parsing.
 * Returns fallback if key doesn't exist or parsing fails.
 */
export function get<T>(key: StorageKey, fallback: T, suffix?: string): T {
  try {
    const item = localStorage.getItem(buildKey(key, suffix))
    if (item === null) return fallback
    return JSON.parse(item) as T
  } catch {
    return fallback
  }
}

/**
 * The outcome of a raw read, distinguishing a genuine backend failure from an
 * absent key or corrupt JSON.
 *
 * `get` collapses all three non-`present` cases into its fallback, which hides
 * the one case a caller must treat specially: when `localStorage.getItem`
 * itself throws (storage disabled, quota, security policy) the stored bytes may
 * still be intact, so writing the fallback back would destroy recoverable data.
 * `absent` and `corrupt`, by contrast, are safely overwritable.
 */
export type ReadResult<T> =
  | { status: 'present'; value: T }
  | { status: 'absent' }
  | { status: 'corrupt' }
  | { status: 'failed' }

/**
 * Read and JSON-parse a value, reporting *why* it is unavailable instead of
 * folding every failure into a fallback. A throwing backend read surfaces as
 * `failed` so callers can suppress writes to a bucket they could not read.
 */
export function read<T>(key: StorageKey, suffix?: string): ReadResult<T> {
  let item: string | null
  try {
    item = localStorage.getItem(buildKey(key, suffix))
  } catch {
    return { status: 'failed' }
  }
  if (item === null) return { status: 'absent' }
  try {
    return { status: 'present', value: JSON.parse(item) as T }
  } catch {
    return { status: 'corrupt' }
  }
}

/**
 * Set a value in localStorage with JSON stringification.
 */
export function set<T>(key: StorageKey, value: T, suffix?: string): void {
  try {
    localStorage.setItem(buildKey(key, suffix), JSON.stringify(value))
  } catch (error) {
    console.warn(`[localStorage] Failed to set ${key}:`, error)
  }
}

/**
 * Get raw string value (for non-JSON data like atomWithStorage compatibility).
 */
export function getRaw(key: StorageKey, suffix?: string): string | null {
  return localStorage.getItem(buildKey(key, suffix))
}
