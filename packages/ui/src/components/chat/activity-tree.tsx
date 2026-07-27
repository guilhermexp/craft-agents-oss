/**
 * activity-tree.tsx
 *
 * The activity-timeline half of a turn card: the status icon, the tool/thinking
 * rows, the Task-subagent group rows, inline image previews and the todo list.
 * Extracted from TurnCard.tsx so the turn shell, the activity tree and the
 * response card are three files instead of one 3.4k-line module.
 */
import * as React from 'react'
import { useEffect, useCallback, useState } from 'react'
import i18n from 'i18next'
import { normalizePath } from '@craft-agent/core/utils'
import { LazyMotion, m, AnimatePresence, domAnimation } from 'motion/react'
import { ChevronRight, CheckCircle2, XCircle, Circle, MessageCircleDashed, ArrowUpRight, Ban, CircleCheck, Pencil, FilePenLine } from 'lucide-react'
import { cn } from '../../lib/utils'
import { usePlatform } from '../../context/PlatformContext'
import { Spinner } from '../ui/LoadingIndicator'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'
import { formatDuration, formatTokens, type ActivityGroup } from './turn-utils'
import { SIZE_CONFIG, type ActivityItem, type ActivityStatus, type TodoItem, type TodoStatus, type GroupExpansionController } from './turn-card-shared'
import { formatToolDisplay, formatToolInput, computeEditWriteDiffStats, stripMarkdown, getToolDescriptor } from './tool-descriptor'


// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Status icon for an activity - exported for reuse in inline execution.
 * Supports custom icons from skill/source metadata when completed.
 * Edit/Write tools show tool-specific icons; others show checkmark or custom icon.
 */
export function ActivityStatusIcon({
  status,
  toolName,
  customIcon
}: {
  status: ActivityStatus
  toolName?: string
  /** Custom icon from tool metadata - emoji or data URL (base64) */
  customIcon?: string
}) {
  // Render the appropriate icon based on status
  const renderIcon = () => {
    // For completed status with custom icon, use it instead of checkmark
    if (status === 'completed' && customIcon) {
      // Check if it's an emoji (short string, not a URL or data URL)
      // Emojis can be 1-4+ characters due to ZWJ sequences
      const isLikelyEmoji = customIcon.length <= 8 && !/^(https?:\/\/|data:)/.test(customIcon)
      if (isLikelyEmoji) {
        return (
          <span className={cn(SIZE_CONFIG.iconSize, "shrink-0 flex items-center justify-center text-[10px] leading-none")}>
            {customIcon}
          </span>
        )
      }
      // Otherwise it's a data URL (base64) or HTTP URL
      return (
        <img
          src={customIcon}
          alt=""
          className={cn(SIZE_CONFIG.iconSize, "shrink-0 rounded-sm object-contain")}
        />
      )
    }

    // Default icon logic
    switch (status) {
      case 'pending':
        return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
      case 'running':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={SIZE_CONFIG.spinnerSize} />
          </div>
        )
      case 'backgrounded':
        return (
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            <Spinner className={cn(SIZE_CONFIG.spinnerSize, "text-accent")} />
          </div>
        )
      case 'completed':
        // Edit and Write tools get their own icons with accent color instead of green checkmark
        if (getToolDescriptor(toolName).completedIcon === 'edit') {
          return <Pencil className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        if (getToolDescriptor(toolName).completedIcon === 'write') {
          return <FilePenLine className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
        }
        return <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-success")} />
      case 'error':
        return <XCircle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-destructive")} />
    }
  }

  // Wrap in AnimatePresence for crossfade between states
  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={status}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="shrink-0"
        >
          {renderIcon()}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  )
}

interface ActivityRowProps {
  activity: ActivityItem
  /** Callback to open activity details in Monaco */
  onOpenDetails?: () => void
  /** Whether this is the last child at its depth level (for └ corner in tree view) */
  isLastChild?: boolean
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
}

/**
 * TreeViewConnector is no longer used - the vertical line from the expanded section
 * already provides visual hierarchy. Keeping this as a no-op for now in case
 * we need depth indentation in the future.
 */
function TreeViewConnector({ depth }: { depth: number; isLastChild?: boolean }) {
  if (depth === 0) return null

  // Just add indentation based on depth, no connectors
  return (
    <div className="flex self-stretch">
      {Array.from({ length: depth }).map((_, i) => (
        <div key={i} className="w-4 shrink-0" />
      ))}
    </div>
  )
}

// ============================================================================
// Inline image preview (for Read tool on image files)
// ============================================================================

/** Image extensions Chromium can render inline as an <img> thumbnail. */
const IMAGE_PREVIEW_EXTENSIONS: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true, ico: true, avif: true,
}

/** True when the path points to a Chromium-renderable image file. */
function isPreviewableImagePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? IMAGE_PREVIEW_EXTENSIONS[ext] === true : false
}

export function resolveActivityPreviewPath(filePath: string, sessionFolderPath?: string): string {
  const normalized = normalizePath(filePath)
  if (!sessionFolderPath || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return normalized
  return `${normalizePath(sessionFolderPath).replace(/\/+$/, '')}/${normalized.replace(/^\.\/+/, '')}`
}

/** Cache preview data URLs across rows/remounts so scrolling never re-reads. */
const activityImagePreviewCache = new Map<string, Promise<string>>()

/**
 * ActivityImagePreview - Compact inline thumbnail for a Read tool targeting an
 * image. Loads a size-bounded preview via the platform layer (prefers the
 * resized preview loader, falls back to the full data URL). Renders nothing
 * until loaded and stays silent on failure — the row's filename badge is the
 * fallback, so a missing/denied file never clutters the compact timeline.
 */
function ActivityImagePreview({ filePath }: { filePath: string }) {
  const { onReadFilePreviewDataUrl, onReadFileDataUrl, onResolveFilePath } = usePlatform()
  const [imageSrc, setImageSrc] = useState<string | null>(null)

  useEffect(() => {
    const usePreviewLoader = !!onReadFilePreviewDataUrl
    const loader = onReadFilePreviewDataUrl
      ? (p: string) => onReadFilePreviewDataUrl(p, 96)
      : onReadFileDataUrl
    if (!loader) return

    let cancelled = false
    setImageSrc(null)

    const load = async (): Promise<string | null> => {
      const resolved = onResolveFilePath ? await onResolveFilePath(filePath) : filePath
      if (!resolved) return null
      const cacheKey = `${usePreviewLoader ? 'preview96' : 'full'}:${resolved}`
      const cached = activityImagePreviewCache.get(cacheKey)
      if (cached) return cached
      const request = loader(resolved).catch((err) => {
        activityImagePreviewCache.delete(cacheKey)
        throw err
      })
      // cap fixo; LRU se algum dia cachearmos full-res de novo
      if (activityImagePreviewCache.size > 300) activityImagePreviewCache.clear()
      activityImagePreviewCache.set(cacheKey, request)
      return request
    }

    load()
      .then((url) => { if (!cancelled && url) setImageSrc(url) })
      .catch(() => { /* silent: keep the filename badge as the fallback */ })

    return () => { cancelled = true }
  }, [filePath, onReadFilePreviewDataUrl, onReadFileDataUrl, onResolveFilePath])

  if (!imageSrc) return null

  const fileName = filePath.split('/').pop() || filePath
  return (
    <img
      src={imageSrc}
      alt={fileName}
      loading="lazy"
      draggable={false}
      className="h-8 w-auto max-w-[120px] shrink-0 rounded-[4px] border border-border/60 object-contain shadow-minimal"
    />
  )
}

/** Single activity row in expanded view */
export function ActivityRow({ activity, onOpenDetails, isLastChild, sessionFolderPath, displayMode = 'detailed' }: ActivityRowProps) {
  const depth = activity.depth || 0

  // Intermediate messages (LLM commentary) - render with dashed circle icon
  // Show "Thinking" while streaming, stripped markdown content when complete
  if (activity.type === 'intermediate') {
    const isThinking = activity.status === 'running'
    const displayContent = isThinking ? 'Thinking...' : stripMarkdown(activity.content || '')
    const isComplete = activity.status === 'completed'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "group/row flex items-start gap-2 py-0.5 text-foreground/75 flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
          onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
          onKeyDown={onOpenDetails && isComplete ? (e) => { if (e.key === 'Enter' || e.key === ' ') onOpenDetails() } : undefined}
        >
          {isThinking ? (
            <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
              <Spinner className={SIZE_CONFIG.spinnerSize} />
            </div>
          ) : (
            <MessageCircleDashed className={cn(SIZE_CONFIG.iconSize, "shrink-0")} />
          )}
          <span className={cn("flex-1 min-w-0 whitespace-normal break-words leading-relaxed", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayContent}</span>
          {/* Open details button */}
          {onOpenDetails && isComplete && (
            <button
              type="button"
              aria-label={i18n.t('chat.viewTurnDetails')}
              onClick={(e) => {
                e.stopPropagation()
                onOpenDetails()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  onOpenDetails()
                }
              }}
              className={cn(
                "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
                "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
            >
              <ArrowUpRight className={SIZE_CONFIG.iconSize} />
            </button>
          )}
        </div>
      </div>
    )
  }

  // Status activities (e.g., compacting) - system-level with distinct styling
  if (activity.type === 'status') {
    const isRunning = activity.status === 'running'
    return (
      <div className="flex items-stretch">
        <TreeViewConnector depth={depth} isLastChild={isLastChild} />
        <div
          className={cn(
            "flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
            SIZE_CONFIG.fontSize
          )}
        >
          <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
            {isRunning ? (
              <Spinner className={SIZE_CONFIG.spinnerSizeSmall} />
            ) : (
              <CheckCircle2 className={cn(SIZE_CONFIG.iconSize, "text-success")} />
            )}
          </div>
          <span className="truncate">{activity.content}</span>
        </div>
      </div>
    )
  }

  // Tool activities - show with status icon
  // Format: "[DisplayName] · [Intent/Description] [Params]"
  // - DisplayName: From toolDisplayMeta (embedded in message) or LLM-generated or fallback
  // - Intent: For MCP tools (activity.intent), for Bash (toolInput.description)
  // - Params: Remaining tool input summary
  const toolDisplay = formatToolDisplay(activity)
  const fullDisplayName = toolDisplay.name
    || (activity.type === 'thinking' ? 'Thinking' : 'Processing')

  // Classify the tool once — icon / badge / preview all branch on this.
  const descriptor = getToolDescriptor(activity.toolName)
  const isMcpOrApiTool = descriptor.isMcp

  // For MCP/API tools, extract source name and tool slug
  // e.g., "ClickUp: clickup_search" -> sourceName="ClickUp", toolSlug="clickup_search"
  let sourceName = fullDisplayName
  let toolSlug: string | undefined = undefined
  if (isMcpOrApiTool) {
    const colonIndex = fullDisplayName.indexOf(':')
    if (colonIndex > 0) {
      sourceName = fullDisplayName.substring(0, colonIndex).trim()
      toolSlug = fullDisplayName.substring(colonIndex + 1).trim()
    }
  }

  // For non-MCP tools or informative mode, use the appropriate display name
  const displayedName: string = isMcpOrApiTool ? sourceName : fullDisplayName

  // Intent for MCP tools, description for Bash commands
  const intentOrDescription = activity.intent || (activity.toolInput?.description as string | undefined)
  const inputSummary = formatToolInput(activity.toolInput, activity.toolName, sessionFolderPath)
  const diffStats = computeEditWriteDiffStats(activity.toolName, activity.toolInput)
  const isComplete = activity.status === 'completed' || activity.status === 'error'
  const isBackgrounded = activity.status === 'backgrounded'
  const previewFilePath = typeof activity.toolInput?.file_path === 'string'
    ? resolveActivityPreviewPath(activity.toolInput.file_path, sessionFolderPath)
    : undefined

  // For backgrounded tasks, show task/shell ID and elapsed time
  const backgroundInfo = isBackgrounded
    ? activity.taskId
      ? `Task ID: ${activity.taskId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
      : activity.shellId
        ? `Shell ID: ${activity.shellId}${activity.elapsedSeconds ? `, ${formatDuration(activity.elapsedSeconds * 1000)} elapsed` : ''}`
        : null
    : null

  return (
    <div className="flex items-stretch">
      <TreeViewConnector depth={depth} isLastChild={isLastChild} />
      <div
        className={cn(
          "group/row flex items-center gap-2 py-0.5 text-muted-foreground flex-1 min-w-0",
          SIZE_CONFIG.fontSize
        )}
        onClick={onOpenDetails && isComplete ? onOpenDetails : undefined}
        onKeyDown={onOpenDetails && isComplete ? (e) => { if (e.key === 'Enter' || e.key === ' ') onOpenDetails() } : undefined}
      >
        <ActivityStatusIcon status={activity.status} toolName={activity.toolName} customIcon={toolDisplay.icon} />
        {/* MCP/API tools: Source name (shrink-0) then error badge (if any) then compound label (flex-1) */}
        {isMcpOrApiTool && !isBackgrounded && (
          <>
            <span className="shrink-0">{sourceName}</span>
            {/* Error badge for MCP/API tools */}
            {activity.status === 'error' && activity.error && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                    style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
                  >
                    {i18n.t('common.error')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[400px]">
                  {activity.error}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Model badge for LLM Query */}
            {descriptor.isCallLlm && activity.toolInput?.model && (
              <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[10px] text-foreground/60 shrink-0">
                {String(activity.toolInput.model)}
              </span>
            )}
            {(intentOrDescription || (displayMode === 'detailed' && (toolSlug || inputSummary))) && (
              <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
                {intentOrDescription && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span>{intentOrDescription}</span>
                  </>
                )}
                {displayMode === 'detailed' && toolSlug && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-70">{toolSlug}</span>
                  </>
                )}
                {displayMode === 'detailed' && inputSummary && (
                  <>
                    <span className="opacity-60"> · </span>
                    <span className="opacity-50">{inputSummary}</span>
                  </>
                )}
              </span>
            )}
          </>
        )}
        {/* Native tools: Tool name (shrink-0) */}
        {!isMcpOrApiTool && (
          <span className={cn("shrink-0", onOpenDetails && isComplete && "group-hover/row:underline")}>{displayedName}</span>
        )}
        {/* Diff stats and filename badges - after tool name */}
        {!isMcpOrApiTool && !isBackgrounded && diffStats && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            {diffStats.deletions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] shadow-tinted rounded-[4px] text-destructive"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >{diffStats.deletions}</span>
            )}
            {diffStats.additions > 0 && (
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--success)_5%,var(--background))] shadow-tinted rounded-[4px] text-success"
                style={{ '--shadow-color': 'var(--success-rgb)' } as React.CSSProperties}
              >{diffStats.additions}</span>
            )}
            {/* Filename badge - supports both Claude Code and Codex formats */}
            {(() => {
              // Claude Code format: file_path
              if (typeof activity.toolInput?.file_path === 'string') {
                return (
                  <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                    {normalizePath(activity.toolInput.file_path).split('/').pop()}
                  </span>
                )
              }
              // Codex format: changes[0].path
              if (Array.isArray(activity.toolInput?.changes)) {
                const firstChange = activity.toolInput.changes[0] as { path?: string } | undefined
                if (firstChange?.path) {
                  return (
                    <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
                      {normalizePath(firstChange.path).split('/').pop()}
                    </span>
                  )
                }
              }
              return null
            })()}
          </span>
        )}
        {/* Filename badge for Read tool (no diff stats) */}
        {!isMcpOrApiTool && !isBackgrounded && !diffStats && descriptor.isRead && typeof activity.toolInput?.file_path === 'string' && (
          <span className="flex items-center gap-1.5 text-[10px] shrink-0">
            <span className="px-1.5 py-0.5 bg-background shadow-minimal rounded-[4px] text-[11px] text-foreground/70">
              {normalizePath(activity.toolInput.file_path).split('/').pop()}
            </span>
          </span>
        )}
        {/* Inline thumbnail for Read tool on image files */}
        {!isMcpOrApiTool && !isBackgrounded && activity.status !== 'error'
          && descriptor.isRead
          && previewFilePath
          && isPreviewableImagePath(previewFilePath) && (
          <ActivityImagePreview filePath={previewFilePath} />
        )}
        {/* Error badge for native tools */}
        {!isMcpOrApiTool && activity.status === 'error' && activity.error && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="px-1.5 py-0.5 bg-[color-mix(in_oklab,var(--destructive)_4%,var(--background))] shadow-tinted rounded-[4px] text-[10px] text-destructive font-medium cursor-default shrink-0"
                style={{ '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties}
              >
                Error
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[400px]">
              {activity.error}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Native tools: Compound label with description + params (flex-1) */}
        {/* In informative mode, hide inputSummary (command details) - only show description */}
        {!isMcpOrApiTool && !isBackgrounded && (intentOrDescription || (displayMode === 'detailed' && inputSummary)) && (
          <span className={cn("truncate flex-1 min-w-0", onOpenDetails && isComplete && "group-hover/row:underline")}>
            {intentOrDescription && (
              <>
                <span className="opacity-60"> · </span>
                <span>{intentOrDescription}</span>
              </>
            )}
            {displayMode === 'detailed' && inputSummary && (
              <>
                <span className="opacity-60"> · </span>
                <span className="opacity-50">{inputSummary}</span>
              </>
            )}
          </span>
        )}
        {/* Background task info (task/shell ID + elapsed time) */}
        {backgroundInfo && (
          <>
            <span className="opacity-60 shrink-0">·</span>
            <span className="truncate min-w-0 max-w-[300px] text-accent">{backgroundInfo}</span>
          </>
        )}
        {/* No spacer needed - both MCP/API and native tools now have flex-1 on their compound spans */}
        {/* Open details button */}
        {onOpenDetails && isComplete && (
          <button
            type="button"
            aria-label={i18n.t('chat.viewTurnDetails')}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetails()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenDetails()
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Activity Group Component (for Task subagents)
// ============================================================================

interface ActivityGroupRowProps {
  group: ActivityGroup
  /** Resolved, single-polarity expansion controller. Omit for uncontrolled (default collapsed). */
  groupExpansion?: GroupExpansionController
  /** Callback to open activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Animation index for staggered animation */
  animationIndex?: number
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
}

/**
 * Renders a Task subagent with its child activities grouped together.
 * Provides visual containment and collapsible children.
 */
export function ActivityGroupRow({ group, groupExpansion, onOpenActivityDetails, animationIndex = 0, sessionFolderPath, displayMode = 'detailed' }: ActivityGroupRowProps) {
  const groupId = group.parent.id
  // Uncontrolled fallback: local expanded-set, default collapsed.
  const [localExpanded, setLocalExpanded] = useState<Set<string>>(new Set())
  const isExpanded = groupExpansion ? groupExpansion.isExpanded(groupId) : localExpanded.has(groupId)

  const toggleExpanded = useCallback(() => {
    if (groupExpansion) {
      groupExpansion.setExpanded(groupId, !isExpanded)
      return
    }
    setLocalExpanded(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [groupId, isExpanded, groupExpansion])

  const description = group.parent.toolInput?.description as string | undefined
  const subagentType = group.parent.toolInput?.subagent_type as string | undefined
  const isComplete = group.parent.status === 'completed' || group.parent.status === 'error'
  const hasError = group.parent.status === 'error'

  return (
    <LazyMotion features={domAnimation}>
    <m.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: animationIndex < SIZE_CONFIG.staggeredAnimationLimit ? animationIndex * 0.03 : 0.3 }}
      className="space-y-0.5"
    >
      {/* Task header row - no left padding, chevron aligned with activity row icons */}
      <div
        className={cn(
          "group/row flex w-full items-center gap-2 py-0.5 rounded-md cursor-pointer text-muted-foreground",
          "hover:text-foreground transition-colors",
          SIZE_CONFIG.fontSize
        )}
        onClick={toggleExpanded}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpanded() }}
      >
        {/* Chevron for expand/collapse - aligned with activity row icons */}
        <m.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
        >
          <ChevronRight className={SIZE_CONFIG.iconSize} />
        </m.div>

        {/* Status icon - aligned with tool call icons */}
        <ActivityStatusIcon status={group.parent.status} toolName={group.parent.toolName} />

        {/* Subagent type badge */}
        <span className="shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium">
          {subagentType || 'Task'}
        </span>

        {/* Task description or fallback */}
        <span className={cn(
          "truncate",
          hasError && "text-destructive"
        )}>
          {description || 'Task'}
        </span>

        {/* Duration and token stats from TaskOutput (only when complete) */}
        {isComplete && group.taskOutputData && (
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
            {group.taskOutputData.durationMs !== undefined && (
              <span>{formatDuration(group.taskOutputData.durationMs)}</span>
            )}
            {group.taskOutputData.durationMs !== undefined &&
              (group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span className="mx-1">·</span>
            )}
            {(group.taskOutputData.inputTokens !== undefined || group.taskOutputData.outputTokens !== undefined) && (
              <span>
                {formatTokens((group.taskOutputData.inputTokens || 0) + (group.taskOutputData.outputTokens || 0))} tokens
              </span>
            )}
          </span>
        )}

        {/* Spacer to push details button to right */}
        <span className="flex-1" />

        {/* Open details button for the Task itself */}
        {onOpenActivityDetails && isComplete && (
          <button
            type="button"
            aria-label={i18n.t('chat.viewTurnDetails')}
            onClick={(e) => {
              e.stopPropagation()
              onOpenActivityDetails(group.parent)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onOpenActivityDetails(group.parent)
              }
            }}
            className={cn(
              "p-0.5 rounded-[3px] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0",
              "hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            <ArrowUpRight className={SIZE_CONFIG.iconSize} />
          </button>
        )}
      </div>

      {/* Children with indentation */}
      <AnimatePresence initial={false}>
        {isExpanded && group.children.length > 0 && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            <div className="pl-0 space-y-0.5 border-l-2 border-muted ml-[5px]">
              {group.children.map((child, idx) => (
                <m.div
                  key={child.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.02 }}
                  className="ml-[-4px]"
                >
                  <ActivityRow
                    activity={child}
                    onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(child) : undefined}
                    isLastChild={idx === group.children.length - 1}
                    sessionFolderPath={sessionFolderPath}
                    displayMode={displayMode}
                  />
                </m.div>
              ))}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
    </LazyMotion>
  )
}


// ============================================================================
// TodoList Component (for TodoWrite tool visualization)
// ============================================================================

/** Status icon for a todo item - uses purple filled icon for completed */
function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'pending':
      return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
    case 'in_progress':
      return (
        <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case 'completed':
      return <CircleCheck className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
    case 'interrupted':
      return <Ban className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
  }
}

/** Single todo row - styled like ActivityRow */
function TodoRow({ todo }: { todo: TodoItem }) {
  const displayText = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content

  return (
    <div className={cn(
      "flex items-center gap-2 py-0.5 text-muted-foreground",
      SIZE_CONFIG.fontSize,
      todo.status === 'completed' && "opacity-50"
    )}>
      <TodoStatusIcon status={todo.status} />
      <span className={cn(
        "truncate flex-1",
        todo.status === 'completed' && "line-through"
      )}>
        {displayText}
      </span>
    </div>
  )
}

interface TodoListProps {
  todos: TodoItem[]
}

/**
 * TodoList - Displays the current state of TodoWrite tool
 * Styled to blend with TurnCard activities
 */
export function TodoList({ todos }: TodoListProps) {
  if (todos.length === 0) return null

  return (
    <div className="pl-4 pr-2 pt-2.5 pb-1.5 space-y-0.5 border-l-2 border-muted ml-[13px]">
      {/* Header */}
      <div className={cn("text-muted-foreground pb-1", SIZE_CONFIG.fontSize)}>
        Todo List
      </div>
      {/* Todo items */}
      {todos.map((todo, index) => (
        <m.div
          key={`${todo.content}-${index}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.03 }}
        >
          <TodoRow todo={todo} />
        </m.div>
      ))}
    </div>
  )
}
