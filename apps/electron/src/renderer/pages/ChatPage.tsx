/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, Globe, Copy, RefreshCw, Link2Off, Info, Trash2 } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ChannelBadge } from '@/components/app-shell/ChannelBadge'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { PanelRightRounded } from '@/components/icons/PanelRightRounded'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { toast } from 'sonner'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext, usePendingPermission, usePendingCredential, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { routes } from '@/lib/navigate'
import { resolveOpenFilePath } from '@/lib/resolve-open-file-path'
import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
import { coerceInputText } from '@/lib/input-text'
import { ensureSessionMessagesLoadedAtom, loadedSessionsAtom, sessionMetaMapAtom, updateSessionAtom } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'

export interface ChatPageProps {
  sessionId: string
}

type InlineFileResolveCacheEntry = {
  promise: Promise<string | null>
  expiresAt: number
}

const INLINE_FILE_MISSING_CACHE_TTL_MS = 10_000
const HEADER_ICON_ONLY_BUTTON_CLASS = '!bg-transparent !shadow-none hover:!bg-transparent'

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    workspaces,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    enabledSources,
    skills,
    labels,
    workspaceChannels,
    onSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onSessionSourcesChange,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onDeleteSession,
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()
  const { updateRightSidebar } = useNavigation()
  const navigationState = useNavigationState()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  const updateSession = useSetAtom(updateSessionAtom)

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  React.useEffect(() => {
    ensureMessagesLoaded(sessionId)
  }, [sessionId, ensureMessagesLoaded])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  React.useEffect(() => {
    inputValueRef.current = inputValue
  })

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

  // Listen for restore-input events (queued messages restored to input on abort)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Session model change handler - persists per-session model and connection
  const handleModelChange = React.useCallback((model: string, connection?: string) => {
    updateSession(sessionId, current => current ? {
      ...current,
      model,
      llmConnection: connection ?? current.llmConnection,
    } : current)
    if (activeWorkspaceId) {
      window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
        .catch(error => {
          console.error('Failed to change model:', error)
        })
    }
  }, [sessionId, activeWorkspaceId, updateSession])

  // Session connection change handler - can only change before first message
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      // Connection change may fail if session already started or connection is invalid
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

  // Hermes profile can change at any time; active streams keep running and the next turn uses the new profile.
  const handleHermesProfileChange = React.useCallback(async (profileName: string) => {
    const previousProfile = session?.hermesProfile
    updateSession(sessionId, current => current ? { ...current, hermesProfile: profileName } : current)
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setHermesProfile', profileName })
    } catch (error) {
      updateSession(sessionId, current => current ? { ...current, hermesProfile: previousProfile } : current)
      throw error
    }
  }, [session?.hermesProfile, sessionId, updateSession])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory
  const activeWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  )
  const inlineFileResolveCacheRef = React.useRef<Map<string, InlineFileResolveCacheEntry>>(null as unknown as Map<string, InlineFileResolveCacheEntry>)
  inlineFileResolveCacheRef.current ??= new Map()
  const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

  const resolveSessionFilePath = React.useCallback(
    async (path: string) => {
      const workspaceRootPath = activeWorkspace?.rootPath
      const sessionFolderPath = session?.sessionFolderPath
        ?? (workspaceRootPath ? `${workspaceRootPath}/sessions/${sessionId}` : undefined)
      const { path: resolved, fallbackPath, found } = await resolveOpenFilePath({
        path,
        sessionId,
        baseDirs: [
          session?.sdkCwd ?? sessionMeta?.sdkCwd,
          workingDirectory,
          sessionFolderPath,
          workspaceRootPath,
          workspaceRootPath ? `${workspaceRootPath}/sessions` : undefined,
        ],
        searchFiles: window.electronAPI.searchFiles,
      })

      return { resolved, fallbackPath, found }
    },
    [workingDirectory, activeWorkspace?.rootPath, session?.sessionFolderPath, session?.sdkCwd, sessionMeta?.sdkCwd, sessionId]
  )

  const resolveInlineFilePath = React.useCallback(
    async (path: string) => {
      const contextKey = [
        sessionId,
        session?.sdkCwd ?? sessionMeta?.sdkCwd ?? '',
        workingDirectory ?? '',
        session?.sessionFolderPath ?? '',
        activeWorkspace?.rootPath ?? '',
      ].join('\u0000')
      const cacheKey = `${contextKey}\u0000${path}`
      const now = Date.now()
      const cached = inlineFileResolveCacheRef.current.get(cacheKey)

      if (cached && cached.expiresAt > now) {
        return cached.promise
      }

      const promise = resolveSessionFilePath(path).then(({ resolved, found }) => {
        const value = found ? resolved : null
        const existing = inlineFileResolveCacheRef.current.get(cacheKey)
        if (existing?.promise === promise) {
          inlineFileResolveCacheRef.current.set(cacheKey, {
            promise: Promise.resolve(value),
            expiresAt: value ? Number.POSITIVE_INFINITY : Date.now() + INLINE_FILE_MISSING_CACHE_TTL_MS,
          })
        }
        return value
      }).catch((err) => {
        inlineFileResolveCacheRef.current.delete(cacheKey)
        throw err
      })

      inlineFileResolveCacheRef.current.set(cacheKey, {
        promise,
        expiresAt: now + INLINE_FILE_MISSING_CACHE_TTL_MS,
      })

      return promise
    },
    [
      activeWorkspace?.rootPath,
      resolveSessionFilePath,
      session?.sdkCwd,
      session?.sessionFolderPath,
      sessionId,
      sessionMeta?.sdkCwd,
      workingDirectory,
    ]
  )

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      const { resolved, fallbackPath } = await resolveSessionFilePath(path)

      if (fallbackPath) {
        toast.info(t('chat.openedClosestMatch', { path: fallbackPath }))
      }

      onOpenFile(resolved)
    },
    [onOpenFile, resolveSessionFilePath, t]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messagesLoaded && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messagesLoaded, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const isFlagged = session?.isFlagged || sessionMeta?.isFlagged || false
  const isArchived = session?.isArchived || sessionMeta?.isArchived || false
  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null
  const currentSessionStatus = session?.sessionStatus || sessionMeta?.sessionStatus || 'todo'
  const hasMessages = !!(session?.messages?.length || sessionMeta?.lastFinalMessageId)
  const hasUnreadMessages = sessionMeta
    ? !!(sessionMeta.lastFinalMessageId && sessionMeta.lastFinalMessageId !== sessionMeta.lastReadMessageId)
    : false
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  const handleRefreshTitle = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'refreshTitle' }) as { success: boolean; title?: string; error?: string } | undefined
    if (result?.success) {
      toast.success(t('toast.titleRefreshed'), { description: result.title })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const handleFlag = React.useCallback(() => {
    onFlagSession(sessionId)
  }, [sessionId, onFlagSession])

  const handleUnflag = React.useCallback(() => {
    onUnflagSession(sessionId)
  }, [sessionId, onUnflagSession])

  const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

  const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

  const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

  const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId])

  // Share action handlers
  const handleShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: { label: t('sendToWorkspace.open'), onClick: () => window.electronAPI.openUrl(result.url!) },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const handleOpenInBrowser = React.useCallback(() => {
    if (sharedUrl) window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const handleCopyLink = React.useCallback(async () => {
    if (sharedUrl) {
      await navigator.clipboard.writeText(sharedUrl)
      toast.success(t('toast.linkCopied'))
    }
  }, [sharedUrl, t])

  const handleUpdateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: result?.error })
    }
  }, [sessionId, t])

  const handleRevokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: result?.error })
    }
  }, [sessionId, t])

  // Share button with dropdown menu rendered in PanelHeader actions slot
  const shareButton = React.useMemo(() => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={sharedUrl ? 'Shared session options' : 'Share session'}
          icon={sharedUrl
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.24 10.29C11.65 10.04 12.15 10.01 12.58 10.19L12.76 10.29L13.01 10.44C14.22 11.23 15.14 12.21 15.87 13.5C16.14 13.98 15.97 14.59 15.49 14.87C15.01 15.14 14.4 14.97 14.13 14.49C13.8 13.91 13.43 13.42 13 12.99V21C13 21.55 12.55 22 12 22C11.45 22 11 21.55 11 21V12.99C10.57 13.42 10.2 13.91 9.87 14.49C9.6 14.97 8.99 15.14 8.51 14.87C8.03 14.59 7.86 13.98 8.13 13.5C8.91 12.13 9.9 11.1 11.24 10.29ZM11.5 3C14.28 3 16.66 4.75 17.59 7.21C20.13 7.91 22 10.24 22 13C22 16.31 19.31 19 16 19H15V17C15.5 17 16.01 16.87 16.48 16.61C17.92 15.79 18.43 13.96 17.61 12.52C16.67 10.85 15.44 9.57 13.8 8.58C12.69 7.91 11.31 7.91 10.2 8.58C8.56 9.57 7.33 10.85 6.39 12.52C5.57 13.96 6.08 15.79 7.52 16.61C7.99 16.87 8.5 17 9 17V19H7C4.24 19 2 16.76 2 14C2 11.95 3.23 10.19 5 9.42C5.05 5.86 7.94 3 11.5 3Z" />
              </svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 8.54C6.74 8.61 5.95 8.81 5.38 9.38C4.5 10.26 4.5 11.67 4.5 14.5V15.5C4.5 18.33 4.5 19.74 5.38 20.62C6.26 21.5 7.67 21.5 10.5 21.5H13.5C16.33 21.5 17.74 21.5 18.62 20.62C19.5 19.74 19.5 18.33 19.5 15.5V14.5C19.5 11.67 19.5 10.26 18.62 9.38C18.05 8.81 17.26 8.61 16 8.54M12 14V3.5M9.5 5.5C10 4.5 10.65 3.79 11.56 3.24C11.76 3.12 11.86 3.06 12 3.06C12.14 3.06 12.24 3.12 12.44 3.24C13.35 3.79 14 4.5 14.5 5.5" />
              </svg>
          }
          className={sharedUrl ? `${HEADER_ICON_ONLY_BUTTON_CLASS} text-accent` : HEADER_ICON_ONLY_BUTTON_CLASS}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {sharedUrl ? (
          <>
            <StyledDropdownMenuItem onClick={handleOpenInBrowser}>
              <Globe className="size-3.5" />
              <span className="flex-1">{t('sessionMenu.openInBrowser')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleCopyLink}>
              <Copy className="size-3.5" />
              <span className="flex-1">{t('sessionMenu.copyLink')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleUpdateShare}>
              <RefreshCw className="size-3.5" />
              <span className="flex-1">{t('sessionMenu.updateShare')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleRevokeShare} variant="destructive">
              <Link2Off className="size-3.5" />
              <span className="flex-1">{t('sessionMenu.stopSharing')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="size-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        ) : (
          <>
            <StyledDropdownMenuItem onClick={handleShare}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 8.54C6.74 8.61 5.95 8.81 5.38 9.38C4.5 10.26 4.5 11.67 4.5 14.5V15.5C4.5 18.33 4.5 19.74 5.38 20.62C6.26 21.5 7.67 21.5 10.5 21.5H13.5C16.33 21.5 17.74 21.5 18.62 20.62C19.5 19.74 19.5 18.33 19.5 15.5V14.5C19.5 11.67 19.5 10.26 18.62 9.38C18.05 8.81 17.26 8.61 16 8.54M12 14V3.5M9.5 5.5C10 4.5 10.65 3.79 11.56 3.24C11.76 3.12 11.86 3.06 12 3.06C12.14 3.06 12.24 3.12 12.44 3.24C13.35 3.79 14 4.5 14.5 5.5" />
              </svg>
              <span className="flex-1">{t('chat.shareOnline')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="size-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ), [sharedUrl, handleShare, handleOpenInBrowser, handleCopyLink, handleUpdateShare, handleRevokeShare, t])

  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="size-4" />}
            aria-label={t("chat.sessionInfo")}
            className={HEADER_ICON_ONLY_BUTTON_CLASS}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta, t])

  const sessionInfoSidebarButton = React.useMemo(() => {
    if (isCompactMode || !sessionMeta) return undefined

    const isOpen = navigationState.rightSidebar?.type === 'session-info'

    return (
      <PanelHeaderCenterButton
        icon={<PanelRightRounded className="size-4" />}
        tooltip={t("chat.sessionInfo")}
        aria-pressed={isOpen}
        onClick={() => updateRightSidebar(isOpen ? undefined : { type: 'session-info' })}
        className={isOpen ? `${HEADER_ICON_ONLY_BUTTON_CLASS} opacity-100` : HEADER_ICON_ONLY_BUTTON_CLASS}
      />
    )
  }, [isCompactMode, navigationState.rightSidebar?.type, sessionMeta, t, updateRightSidebar])

  const quickSessionActions = React.useMemo(() => {
    if (!sessionMeta) return undefined

    return (
      <div className="flex items-center gap-1">
        <PanelHeaderCenterButton
          icon={<RefreshCw className="size-4" />}
          tooltip={t('sessionMenu.regenerateTitle')}
          onClick={() => void handleRefreshTitle()}
          className={HEADER_ICON_ONLY_BUTTON_CLASS}
        />
        <PanelHeaderCenterButton
          icon={<Trash2 className="size-4" />}
          tooltip={t('common.delete')}
          onClick={handleDelete}
          className={`${HEADER_ICON_ONLY_BUTTON_CLASS} text-destructive hover:text-destructive opacity-75 hover:opacity-100`}
        />
      </div>
    )
  }, [handleDelete, handleRefreshTitle, sessionMeta, t])

  const headerActions = React.useMemo(() => {
    if (isCompactMode) {
      return (
        <div className="flex items-center gap-1">
          {quickSessionActions}
          {compactInfoButton}
        </div>
      )
    }

    return (
      <div className="flex items-center gap-1">
        {quickSessionActions}
        {sessionInfoSidebarButton}
        {shareButton}
      </div>
    )
  }, [compactInfoButton, isCompactMode, quickSessionActions, sessionInfoSidebarButton, shareButton])

  // Channel breadcrumb: shown next to the title when the session carries one
  // or more channel-backed labels (Slack-style #channel-name indicator).
  // We prefer fully-loaded session labels but fall back to sessionMeta.labels
  // so the badge is visible during the loading skeleton state too.
  const channelBadge = React.useMemo(() => {
    const sessionLabels = session?.labels ?? sessionMeta?.labels ?? []
    if (sessionLabels.length === 0 || !workspaceChannels?.length) return undefined
    return (
      <ChannelBadge
        sessionLabels={sessionLabels}
        channels={workspaceChannels}
      />
    )
  }, [session?.labels, sessionMeta?.labels, workspaceChannels])

  // Build title menu content for chat sessions using shared SessionMenu
  const titleMenu = React.useMemo(() => sessionMeta ? (
    <SessionMenu
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
      }

      return (
        <>
          <div className="h-full flex flex-col">
            <PanelHeader  title={displayTitle} badge={channelBadge} titleMenu={titleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
            <div className="flex-1 flex flex-col min-h-0">
              <ChatDisplay
                ref={chatDisplayRef}
                session={skeletonSession}
                onSendMessage={() => {}}
                onOpenFile={handleOpenFile}
                onResolveFilePath={resolveInlineFilePath}
                onOpenUrl={handleOpenUrl}
                currentModel={effectiveModel}
                onModelChange={handleModelChange}
                onConnectionChange={handleConnectionChange}
                onHermesProfileChange={handleHermesProfileChange}
                pendingPermission={undefined}
                onRespondToPermission={onRespondToPermission}
                pendingCredential={undefined}
                onRespondToCredential={onRespondToCredential}
                thinkingLevel={sessionOpts.thinkingLevel}
                onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
                permissionMode={sessionOpts.permissionMode}
                onPermissionModeChange={setPermissionMode}
                enabledModes={enabledModes}
                inputValue={inputValue}
                onInputChange={handleInputChange}
                attachmentsValue={attachmentsValue}
                onAttachmentsChange={handleAttachmentsChange}
                sources={enabledSources}
                skills={skills}
                sessionStatuses={sessionStatuses}
                onSessionStatusChange={handleSessionStatusChange}
                workspaceId={activeWorkspaceId || undefined}
                onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
                workingDirectory={sessionMeta.workingDirectory}
                onWorkingDirectoryChange={handleWorkingDirectoryChange}
                messagesLoading={true}
                searchQuery={sessionListSearchQuery}
                isSearchModeActive={isSearchModeActive}
                onMatchInfoChange={onChatMatchInfoChange}
                connectionUnavailable={connectionUnavailable}
                compactMode={!!isCompactMode}
              />
            </div>
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="size-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <PanelHeader  title={displayTitle} badge={channelBadge} titleMenu={titleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
        <div className="flex-1 flex flex-col min-h-0">
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            onSendMessage={(message, attachments, skillSlugs) => {
              if (session) {
                onSendMessage(session.id, message, attachments, skillSlugs)
              }
            }}
            onOpenFile={handleOpenFile}
            onResolveFilePath={resolveInlineFilePath}
            onOpenUrl={handleOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onConnectionChange={handleConnectionChange}
            onHermesProfileChange={handleHermesProfileChange}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            permissionMode={sessionOpts.permissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            sources={enabledSources}
            skills={skills}
            labels={labels}
            onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
            sessionStatuses={sessionStatuses}
            onSessionStatusChange={handleSessionStatusChange}
            workspaceId={activeWorkspaceId || undefined}
            onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
            workingDirectory={workingDirectory}
            onWorkingDirectoryChange={handleWorkingDirectoryChange}
            sessionFolderPath={session?.sessionFolderPath}
            messagesLoading={!messagesLoaded}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={onChatMatchInfoChange}
            connectionUnavailable={connectionUnavailable}
            compactMode={!!isCompactMode}
          />
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
})

export default ChatPage
