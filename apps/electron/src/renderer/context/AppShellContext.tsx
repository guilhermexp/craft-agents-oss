/**
 * AppShellContext
 *
 * Provides session and workspace data to tab panels without prop drilling.
 * This context is used by ChatTabPanel and other components that need
 * access to the current session, workspace, and callback functions.
 */

import * as React from 'react'
import { createContext, useContext, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  CredentialRequest,
  CredentialResponse,
  PermissionMode,
  SessionStatus,
  LoadedSource,
  LoadedSkill,
  NewChatActionParams,
  LlmConnectionWithStatus,
  CreateSessionOptions,
  PermissionResponseOptions,
} from '../../shared/types'
import type { ContentBadge } from '@craft-agent/core'
import type { LabelConfig } from '@craft-agent/shared/labels'
import type { WarRoomChannel } from '@craft-agent/shared/channels'
import type { DraftAttachmentRef } from '@craft-agent/shared/config'
import type { ResolvedSessionStatus } from '@/config/session-status-config'
import type { SessionOptions, SessionOptionUpdates } from '../hooks/useSessionOptions'
import { defaultSessionOptions } from '../hooks/useSessionOptions'
import { sessionAtomFamily } from '../atoms/sessions'

/**
 * Session lifecycle actions plus permission/credential responses.
 *
 * A self-contained surface any session list, menu, or page can drive without
 * knowing anything about workspace data. This is the seam that lets a test build
 * a session-action stub (14 fields) instead of the full provider value.
 */
export interface SessionActions {
  onCreateSession: (workspaceId: string, options?: CreateSessionOptions) => Promise<Session>
  onSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], badges?: ContentBadge[]) => void
  onRenameSession: (sessionId: string, name: string) => void
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionRead: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  /** Track which session user is viewing (for unread state machine) */
  onSetActiveViewingSession: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatus) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  /** Permission prompt response */
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions
  ) => void
  /** Credential prompt response */
  onRespondToCredential?: (
    sessionId: string,
    requestId: string,
    response: CredentialResponse
  ) => void
}

/**
 * Workspace-scoped data plus workspace/label/source mutation callbacks —
 * everything a panel needs to reason about the active workspace and its resources.
 */
export interface WorkspaceData {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Workspace slug for SDK skill qualification (derived from workspace path) */
  activeWorkspaceSlug: string | null
  /** All LLM connections with authentication status */
  llmConnections: LlmConnectionWithStatus[]
  /** Default LLM connection slug for the current workspace */
  workspaceDefaultLlmConnection?: string
  /** Refresh LLM connections from config */
  refreshLlmConnections: () => Promise<void>
  /** All enabled sources for this workspace - provided by AppShell component */
  enabledSources?: LoadedSource[]
  /** All skills for this workspace - provided by AppShell component (for @mentions) */
  skills?: LoadedSkill[]
  /** Working directory of the active session — needed for project-level skill resolution */
  activeSessionWorkingDirectory?: string
  /** All label configs (tree) for label menu and badge display */
  labels?: LabelConfig[]
  /** All workspace channels (used by session header to render channel breadcrumbs) */
  workspaceChannels?: WarRoomChannel[]
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]
  /** Dynamic todo states from workspace config (provided by AppShell, defaults to empty) */
  sessionStatuses?: ResolvedSessionStatus[]
  onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>
  onRefreshWorkspaces?: () => void
  /** Source selection callback (per-session) - provided by AppShell component */
  onSessionSourcesChange?: (sessionId: string, sourceSlugs: string[]) => void
  /** Callback when session labels change */
  onSessionLabelsChange?: (sessionId: string, labels: string[]) => void
  /**
   * Open All Sessions scoped to a task: replaces the view's label filter (and project
   * filter when given) with the task's scope — the same user-clearable header-chip
   * filters — and selects the session. Used by kanban tile/subtask clicks + post-create.
   */
  onJumpToTaskSessions?: (sessionId: string, scope: { labelId: string; projectId?: string }) => void
}

/**
 * Per-session runtime state: pending prompt queues, draft plumbing, and options.
 */
export interface SessionRuntime {
  pendingPermissions: Map<string, PermissionRequest[]>
  pendingCredentials: Map<string, CredentialRequest[]>
  /** Parked AskUserQuestion tool calls per session (toolUseIds awaiting an answer) */
  pendingQuestions: Map<string, Set<string>>
  /** Get draft input text for a session - reads from ref without triggering re-renders */
  getDraft: (sessionId: string) => string
  /** Get persisted attachment refs (path + name) for a session's draft - no file IO */
  getDraftAttachmentRefs: (sessionId: string) => DraftAttachmentRef[]
  /** Hydrate persisted attachment refs into full FileAttachment objects (async, reads files) */
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  /** All session-scoped options in one map. Use useSessionOptionsFor() hook for easy access. */
  sessionOptions: Map<string, SessionOptions>
  onSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void
  /** Input draft callback */
  onInputChange: (sessionId: string, value: string) => void
  /** Attachment draft callback — persists attachment refs per session */
  onAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void
  /** Open a new chat with optional agent, name, and pre-filled input */
  openNewChat?: (params?: NewChatActionParams) => Promise<void>
}

/**
 * Global application actions: file/URL opening (tabs or external apps) plus the
 * top-level settings/reset entry points.
 */
export interface AppActions {
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onReset: () => void
}

/**
 * Panel focus/compact flags shared across the renderer tree. `isFocusedPanel`
 * drives multi-panel visual differentiation and input focus (ChatDisplay,
 * FreeFormInput, InputContainer); `isCompactMode` gates compact-mode UI
 * (SessionItem, mobile menus). The single-consumer chrome nodes (close/back
 * buttons) moved to props across the PanelSlot → MainContentPanel → ChatPage boundary.
 */
export interface PanelChrome {
  /** Whether this panel is the focused panel (for multi-panel visual differentiation) */
  isFocusedPanel?: boolean
  /** Whether the shell is currently in compact/narrow mode */
  isCompactMode?: boolean
}

/**
 * Chat search highlighting wiring between the session list and ChatDisplay.
 *
 * Single consumer (ChatPage), but its producer is AppShell — which itself needs
 * chatDisplayRef for the next/prev-match keyboard actions — and ChatPage sits
 * three layout/router components below it (PanelStackContainer → PanelSlot →
 * MainContentPanel), none of which touch search. Threading these four fields as
 * props would widen three unrelated component APIs with 12 pass-throughs; a
 * four-field named seam is the smaller cost, so this one stays in context.
 */
export interface SessionSearchWiring {
  /** Current search query from session list - used to highlight matches in ChatDisplay */
  sessionListSearchQuery?: string
  /** Whether search mode is active (prevents focus stealing to chat input even with empty query) */
  isSearchModeActive?: boolean
  /** Ref to ChatDisplay for navigation between matches */
  chatDisplayRef?: React.RefObject<ChatDisplayHandle | null>
  /** Callback when ChatDisplay match info changes (for immediate UI updates) */
  onChatMatchInfoChange?: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void
}

/**
 * The full AppShell provider value, composed from focused domain seams. Consumers
 * SHOULD depend on the narrow hook for their domain (useSessionActions,
 * useWorkspaceData, useSessionRuntime, useAppActions, usePanelChrome,
 * useSessionSearchWiring) rather than reaching for the whole surface.
 *
 * NOTE: `sessions` is intentionally absent — use sessionMetaMapAtom for listing
 * and useSession(id) for individual sessions. This prevents closures from
 * retaining the full messages array and causing memory leaks.
 */
export interface AppShellContextType
  extends SessionActions,
    SessionRuntime,
    WorkspaceData,
    AppActions,
    PanelChrome,
    SessionSearchWiring {}

const AppShellContext = createContext<AppShellContextType | null>(null)

export function AppShellProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AppShellContextType
}) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
}

/** Returns context or null if outside provider (safe for optional consumers like playground) */
export function useOptionalAppShellContext(): AppShellContextType | null {
  return useContext(AppShellContext)
}

export function useAppShellContext(): AppShellContextType {
  const context = useContext(AppShellContext)
  if (!context) {
    throw new Error('useAppShellContext must be used within an AppShellProvider')
  }
  return context
}

/**
 * Domain seams over the AppShell context. Each returns the same provider value
 * narrowed to one domain interface, so a consumer depends on 4–18 fields instead
 * of the full surface. No allocation — the returned object is the context itself.
 */
export function useSessionActions(): SessionActions {
  return useAppShellContext()
}

/** Workspace-scoped data + workspace/label/source callbacks. */
export function useWorkspaceData(): WorkspaceData {
  return useAppShellContext()
}

/** Per-session runtime state: pending queues, drafts, options. */
export function useSessionRuntime(): SessionRuntime {
  return useAppShellContext()
}

/** Global application actions (open file/url, settings, reset). */
export function useAppActions(): AppActions {
  return useAppShellContext()
}

/** Panel focus/compact flags. */
export function usePanelChrome(): PanelChrome {
  return useAppShellContext()
}

/** Chat search highlighting wiring (session list ↔ ChatDisplay). */
export function useSessionSearchWiring(): SessionSearchWiring {
  return useAppShellContext()
}

/**
 * Get a specific session by ID using per-session atoms
 * This hook only re-renders when the specific session changes,
 * not when other sessions change (solves streaming isolation)
 */
export function useSession(sessionId: string): Session | null {
  // Use per-session atom for isolated updates
  return useAtomValue(sessionAtomFamily(sessionId))
}

/**
 * Get the active workspace
 */
export function useActiveWorkspace(): Workspace | null {
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  if (!activeWorkspaceId) return null
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

/**
 * Get pending permission for a session (first in queue)
 */
export function usePendingPermission(sessionId: string): PermissionRequest | undefined {
  const { pendingPermissions } = useAppShellContext()
  return pendingPermissions.get(sessionId)?.[0]
}

/**
 * Get pending credential request for a session (first in queue)
 */
export function usePendingCredential(sessionId: string): CredentialRequest | undefined {
  const { pendingCredentials } = useAppShellContext()
  return pendingCredentials.get(sessionId)?.[0]
}

/**
 * Hook to get and update session options for a specific session.
 * This is the primary way components should access session options.
 *
 * Usage:
 *   const { options, setPermissionMode } = useSessionOptionsFor(sessionId)
 *   setPermissionMode('safe')
 */
export function useSessionOptionsFor(sessionId: string): {
  options: SessionOptions
  setOption: <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) => void
  setOptions: (updates: SessionOptionUpdates) => void
  setPermissionMode: (mode: PermissionMode) => void
  isSafeModeActive: () => boolean
} {
  const { sessionOptions, onSessionOptionsChange } = useAppShellContext()

  const options = sessionOptions.get(sessionId) ?? defaultSessionOptions

  const setOption = useCallback(<K extends keyof SessionOptions>(
    key: K,
    value: SessionOptions[K]
  ) => {
    onSessionOptionsChange(sessionId, { [key]: value })
  }, [sessionId, onSessionOptionsChange])

  const setOptions = useCallback((updates: SessionOptionUpdates) => {
    onSessionOptionsChange(sessionId, updates)
  }, [sessionId, onSessionOptionsChange])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setOption('permissionMode', mode)
  }, [setOption])

  const isSafeModeActive = useCallback(() => {
    return options.permissionMode === 'safe'
  }, [options.permissionMode])

  return {
    options,
    setOption,
    setOptions,
    setPermissionMode,
    isSafeModeActive,
  }
}
