import { useMemo } from "react"
import { formatDistanceToNowStrict } from "date-fns"
import type { Locale } from "date-fns"
import { CircleHelp, Flag, ShieldAlert } from "lucide-react"
import { useActionLabel } from "@/actions"
import { cn } from "@/lib/utils"
import { rendererPerf } from "@/lib/perf"
import { Spinner } from "@craft-agent/ui"
import { EntityRow } from "@/components/ui/entity-row"
import { EntityListBadge } from "@/components/ui/entity-list-badge"
import { SessionMenu } from "./SessionMenu"
import { BatchSessionMenu } from "./BatchSessionMenu"
import { ConnectionIcon } from "@/components/icons/ConnectionIcon"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { SessionBadges } from "./SessionBadges"
import { SESSION_DRAG_MIME } from "./session-dnd"
import { getSessionTitle, getSessionPreviewText, highlightMatch, hasUnreadMeta, shortTimeLocale } from "@/utils/session"
import { useSessionListContext } from "@/context/SessionListContext"
import { useWorkspaceData, usePanelChrome } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import type { SessionMeta } from "@/atoms/sessions"
import { messagingBindingsBySessionAtom } from "@/atoms/messaging"
import { useAtomValue } from "jotai"
import { extractLabelId } from "@craft-agent/shared/labels"
import type { LlmConnectionWithStatus } from "../../../shared/types"

const PLATFORM_PILL: Record<'telegram' | 'whatsapp', { label: string; colorClass: string }> = {
  telegram: {
    label: 'Telegram',
    colorClass: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300',
  },
  whatsapp: {
    label: 'WhatsApp',
    colorClass: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300',
  },
}

function getHermesProfileSessionBadge(item: SessionMeta): string | null {
  if (item.llmConnection !== 'hermes') return null

  const profile = item.hermesProfile?.trim()
  if (!profile) return null

  const normalized = profile.toLowerCase()
  if (normalized === 'default' || normalized === 'hermes') return null

  return profile
}

function resolveSessionConnection(
  item: SessionMeta,
  llmConnections: LlmConnectionWithStatus[],
  workspaceDefaultLlmConnection?: string,
): LlmConnectionWithStatus | null {
  if (llmConnections.length === 0) return null

  if (item.llmConnection) {
    const lockedConnection = llmConnections.find(connection => connection.slug === item.llmConnection)
    if (lockedConnection) return lockedConnection
  }

  if (workspaceDefaultLlmConnection) {
    const workspaceDefaultConnection = llmConnections.find(connection => connection.slug === workspaceDefaultLlmConnection)
    if (workspaceDefaultConnection) return workspaceDefaultConnection
  }

  return llmConnections.find(connection => connection.isDefault) ?? llmConnections[0] ?? null
}

function SessionConnectionIcon({ connection }: { connection: LlmConnectionWithStatus }) {
  return (
    <span
      className="flex !h-3.5 !w-3.5 shrink-0 items-center justify-center opacity-80"
      title={connection.name}
      aria-label={connection.name}
    >
      <ConnectionIcon connection={connection} size={14} />
    </span>
  )
}

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup,
  isInMultiSelect,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const ctx = useSessionListContext()
  const { workspaces, llmConnections, workspaceDefaultLlmConnection } = useWorkspaceData()
  const { isCompactMode } = usePanelChrome()
  const hasRemoteWorkspaces = workspaces?.some(w => w.remoteServer) ?? false
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession ? activeMatch!.count : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasLabels = !!(item.labels && item.labels.length > 0 && ctx.flatLabels.length > 0 && item.labels.some(entry => {
    const labelId = extractLabelId(entry)
    return ctx.flatLabels.some(l => l.id === labelId)
  }))
  const hasPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const hasPendingQuestion = ctx.hasPendingQuestion?.(item.id) ?? false
  const previewText = isCompactMode ? getSessionPreviewText(item) : null
  const messagingBindingsBySession = useAtomValue(messagingBindingsBySessionAtom)
  const sessionBindings = messagingBindingsBySession.get(item.id) ?? []
  const hasMessagingBinding = sessionBindings.length > 0
  const sessionConnection = resolveSessionConnection(item, llmConnections, workspaceDefaultLlmConnection)
  const hermesProfileBadge = getHermesProfileSessionBadge(item)
  const hasTitleSuffix = hasMessagingBinding || hermesProfileBadge !== null

  const titleSuffixNode = useMemo(() => {
    if (!hasTitleSuffix) return undefined
    return (
      <div className="flex min-w-0 items-center gap-1">
        {hermesProfileBadge ? (
          <EntityListBadge
            variant="text"
            colorClass="bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-200"
            className="max-w-[92px] truncate"
            tooltip={`Hermes profile: ${hermesProfileBadge}`}
          >
            {hermesProfileBadge}
          </EntityListBadge>
        ) : null}
        {sessionBindings.map((binding) => {
          const pill = PLATFORM_PILL[binding.platform as 'telegram' | 'whatsapp']
          if (!pill) return null
          return (
            <EntityListBadge
              key={binding.id}
              variant="text"
              colorClass={pill.colorClass}
              tooltip={`Connected to ${pill.label}`}
            >
              {pill.label}
            </EntityListBadge>
          )
        })}
      </div>
    )
  }, [hasTitleSuffix, hermesProfileBadge, sessionBindings])

  const titleTrailingNode = useMemo(() => {
    if (hasMatch) {
      return (
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] px-1 py-0.5 rounded-[6px] text-[10px] font-medium tabular-nums leading-tight whitespace-nowrap shadow-tinted",
            isSelected
              ? "bg-yellow-300/50 border border-yellow-500 text-yellow-900"
              : "bg-yellow-300/10 border border-yellow-600/20 text-yellow-800"
          )}
          style={{
            '--shadow-color': isSelected ? '234, 179, 8' : '133, 77, 14',
          } as React.CSSProperties}
          title={`Matches found (${nextHotkey} next, ${prevHotkey} prev)`}
        >
          {chatMatchCount}
        </span>
      )
    }
    if (item.isFlagged) {
      return (
        <div className="p-1 flex items-center justify-center">
          <Flag className="size-3.5 text-info" />
        </div>
      )
    }
    if (item.lastMessageAt) {
      return (
        <span className="text-[11px] text-foreground/40 whitespace-nowrap">
          {formatDistanceToNowStrict(new Date(item.lastMessageAt), { locale: shortTimeLocale as Locale, roundingMethod: 'floor' })}
        </span>
      )
    }
    return undefined
  }, [hasMatch, chatMatchCount, isSelected, nextHotkey, prevHotkey, item.isFlagged, item.lastMessageAt])

  const badgesNode = useMemo(() => {
    if (!hasLabels) return undefined
    return <SessionBadges item={item} />
  }, [hasLabels, item])

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(SESSION_DRAG_MIME, item.id)
    event.dataTransfer.setData('text/plain', item.id)
  }

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  return (
    <EntityRow
      className="session-item"
      dataAttributes={{ 'data-session-id': item.id }}
      showSeparator={!isFirstInGroup}
      separatorClassName="pl-[38px] pr-4"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      onMouseDown={handleClick}
      buttonProps={{
        ...itemProps,
        draggable: true,
        onDragStart: handleDragStart,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      menuContent={
        <SessionMenu
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          hasRemoteWorkspaces={hasRemoteWorkspaces}
          onDelete={() => ctx.onDelete(item.id)}
        />
      }
      contextMenuContent={ctx.isMultiSelectActive && isInMultiSelect ? <BatchSessionMenu /> : undefined}
      icon={
        <>
          <SessionStatusIcon item={item} />
          {sessionConnection ? <SessionConnectionIcon connection={sessionConnection} /> : null}
          <div className={cn(
            "flex items-center justify-center overflow-hidden gap-1",
            "transition-all duration-200 ease-out",
            (item.isProcessing || hasUnreadMeta(item) || item.lastMessageRole === 'plan' || hasPendingPrompt || hasPendingQuestion)
              ? "opacity-100 ml-0"
              : "!w-0 opacity-0 -ml-[10px]"
          )}>
            {item.isProcessing && <Spinner className="text-[10px]" />}
            {hasUnreadMeta(item) && (
              <svg className="text-accent size-3.5" viewBox="0 0 25 24" fill="currentColor">
                <g transform="translate(1.75, 0.78)">
                  <path fillRule="nonzero" d="M11,22 C8.9,22 7.01,21.54 5.35,20.63 C4.86,21.05 4.29,21.39 3.65,21.63 C3.01,21.88 2.37,22 1.71,22 C1.5,22 1.34,21.95 1.23,21.84 C1.11,21.73 1.06,21.6 1.06,21.45 C1.06,21.29 1.14,21.13 1.28,20.98 C1.57,20.66 1.78,20.34 1.9,20.02 C2.03,19.69 2.09,19.31 2.09,18.87 C2.09,18.46 2.02,18.06 1.88,17.69 C1.74,17.33 1.57,16.94 1.36,16.53 C1.15,16.13 0.94,15.67 0.73,15.17 C0.52,14.66 0.35,14.07 0.21,13.39 C0.07,12.71 0,11.91 0,11 C0,9.41 0.27,7.94 0.81,6.6 C1.36,5.26 2.12,4.09 3.11,3.1 C4.09,2.12 5.26,1.35 6.6,0.81 C7.94,0.27 9.4,0 11,0 C12.59,0 14.05,0.27 15.39,0.81 C16.74,1.35 17.9,2.12 18.89,3.1 C19.88,4.09 20.64,5.26 21.19,6.6 C21.73,7.94 22,9.41 22,11 C22,12.59 21.73,14.06 21.19,15.4 C20.64,16.74 19.88,17.91 18.89,18.9 C17.91,19.88 16.74,20.65 15.4,21.19 C14.06,21.73 12.59,22 11,22 Z" />
                </g>
              </svg>
            )}
            {item.lastMessageRole === 'plan' && (
              <svg className="text-success size-3.5" viewBox="0 0 25 24" fill="currentColor">
                <path fillRule="nonzero" d="M13.72,22.65 C13.26,22.65 12.94,22.49 12.73,22.16 C12.53,21.84 12.36,21.43 12.22,20.94 L10.66,15.79 C10.57,15.46 10.54,15.2 10.57,15 C10.59,14.8 10.7,14.6 10.89,14.4 L20.86,3.65 C20.92,3.59 20.95,3.52 20.95,3.45 C20.95,3.38 20.92,3.32 20.87,3.28 C20.82,3.23 20.76,3.21 20.69,3.2 C20.62,3.2 20.56,3.23 20.5,3.29 L9.79,13.3 C9.57,13.49 9.36,13.6 9.16,13.62 C8.96,13.65 8.7,13.61 8.39,13.51 L3.12,11.91 C2.65,11.77 2.26,11.6 1.95,11.4 C1.65,11.2 1.49,10.88 1.49,10.43 C1.49,10.07 1.63,9.77 1.91,9.52 C2.19,9.26 2.54,9.06 2.95,8.9 L19.75,2.47 C19.97,2.38 20.19,2.32 20.39,2.27 C20.58,2.22 20.76,2.19 20.93,2.19 C21.25,2.19 21.5,2.28 21.68,2.47 C21.86,2.65 21.95,2.9 21.95,3.22 C21.95,3.39 21.93,3.57 21.88,3.77 C21.83,3.96 21.76,4.17 21.68,4.4 L15.28,21.11 C15.1,21.58 14.88,21.95 14.63,22.23 C14.38,22.51 14.07,22.65 13.72,22.65 Z" />
              </svg>
            )}
            {hasPendingPrompt && <ShieldAlert className="size-3.5 text-info" />}
            {hasPendingQuestion && <CircleHelp className="size-3.5 text-info" />}
          </div>
        </>
      }
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn("text-[13px]", item.isAsyncOperationOngoing && "animate-shimmer-text")}
      subtitle={previewText}
      titleSuffix={titleSuffixNode}
      titleTrailing={titleTrailingNode}
      badges={badgesNode}
    />
  )
}
