import { createContext, useContext } from "react"
import type { LabelConfig } from "@craft-agent/shared/labels"
import type { SessionStatusId, ResolvedSessionStatus } from "@/config/session-status-config"
import type { SessionMeta } from "@/atoms/sessions"
import type { SessionOptions } from "@/hooks/useSessionOptions"
import type { ContentSearchResult } from "@/hooks/useSessionSearch"

/**
 * Split into two contexts on purpose.
 *
 * The session list is not virtualized, so every value here is read by every
 * row. When actions and view state shared one provider, a single keystroke in
 * the search box or a change of selection produced a new context identity and
 * re-rendered all ~1800 row subtrees — including the `Popover` that
 * `SessionStatusIcon` mounts per row, which the profiler measured at a 100%
 * wasted-render rate.
 *
 * Rows that only dispatch actions (`SessionStatusIcon`, `SessionBadges`) now
 * subscribe to the stable half and stop re-rendering on selection and search.
 * `SessionItem`, which genuinely renders selection and highlight state, reads
 * both — its churn is real, not incidental.
 */

/** Callbacks and workspace config. Identity changes only when the workspace does. */
export interface SessionListActions {
  onRenameClick: (sessionId: string, currentName: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onLabelsChange?: (sessionId: string, labels: string[]) => void
  /** Set or clear the project binding for a session (null = unbind) */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** Available workspace projects for the context-menu submenu */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  onSelectSessionById: (sessionId: string) => void
  onOpenInNewWindow: (item: SessionMeta) => void
  onSendToWorkspace?: (sessionIds: string[]) => void
  onFocusZone: () => void
  onKeyDown: (e: React.KeyboardEvent, item: SessionMeta) => void

  sessionStatuses: ResolvedSessionStatus[]
  flatLabels: LabelConfig[]
  labels: LabelConfig[]
  sessionOptions?: Map<string, SessionOptions>
}

/** Selection, search and transient per-session flags. Changes on every keystroke. */
export interface SessionListView {
  searchQuery?: string
  selectedSessionId?: string | null
  isMultiSelectActive: boolean
  contentSearchResults: Map<string, ContentSearchResult>
  /** DOM-verified match info for the active session (count, highlighting state) */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
  /** Whether a session currently has a pending permission/admin prompt */
  hasPendingPrompt?: (sessionId: string) => boolean
  /** Whether a session has a parked AskUserQuestion awaiting the user's answer */
  hasPendingQuestion?: (sessionId: string) => boolean
}

const SessionListActionsContext = createContext<SessionListActions | null>(null)
const SessionListViewContext = createContext<SessionListView | null>(null)

export function useSessionListActions(): SessionListActions {
  const ctx = useContext(SessionListActionsContext)
  if (!ctx) throw new Error("useSessionListActions must be used within SessionList")
  return ctx
}

export function useSessionListView(): SessionListView {
  const ctx = useContext(SessionListViewContext)
  if (!ctx) throw new Error("useSessionListView must be used within SessionList")
  return ctx
}

export const SessionListActionsProvider = SessionListActionsContext.Provider
export const SessionListViewProvider = SessionListViewContext.Provider
