/**
 * UserMessageBubble - Shared user message component
 *
 * Displays user messages with right-aligned styling:
 * - Subtle background (5% foreground)
 * - Pill-shaped corners
 * - Max width 80%
 * - Markdown rendering for links and code
 * - Optional file attachments with thumbnails
 * - Content badges for @mentions (sources, skills)
 * - Pending/queued states (Electron only)
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import type { StoredAttachment, ContentBadge } from '@craft-agent/core'
import { normalizePath } from '@craft-agent/core/utils'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown/Markdown'
import { FileTypeIcon, getFileTypeLabel } from './attachment-helpers'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../tooltip'
import { useTranslation } from 'react-i18next'

// Fallback text icons for badges without iconDataUrl
// Using simple characters since SVG rendering may not work in all contexts
const SKILL_ICON_TEXT = '✦'
const SOURCE_ICON_TEXT = '⊕'
const CONTEXT_ICON_TEXT = '⚙'
const COMMAND_ICON_TEXT = '/'

/**
 * Check if a badge is an edit_request badge (identified by XML tag in rawText)
 */
function isEditRequestBadge(badge: ContentBadge): boolean {
  return badge.type === 'context' && !!badge.rawText?.includes('<edit_request>')
}

/**
 * EditRequestBadge - Standalone badge rendered above the user message bubble
 * Taller and with larger corner radius than inline badges for visual distinction
 */
function EditRequestBadge({ badge }: { badge: ContentBadge }) {
  const displayLabel = badge.collapsedLabel || badge.label
  return (
    <span className="inline-flex items-center h-[28px] px-2.5 rounded-[8px] bg-background shadow-minimal text-[13px] text-muted-foreground">
      {displayLabel}
    </span>
  )
}

/**
 * InlineBadge - Renders a single content badge inline with text
 * Styled to match the input field badges (bg-background with shadow)
 */
function InlineBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      {badge.iconDataUrl ? (
        <img
          src={badge.iconDataUrl}
          alt=""
          className="size-[12px] rounded-[2px] shrink-0"
        />
      ) : (
        <span className="size-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[8px]">
          {badge.type === 'skill' ? SKILL_ICON_TEXT : badge.type === 'context' ? CONTEXT_ICON_TEXT : SOURCE_ICON_TEXT}
        </span>
      )}
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * CommandBadge - Renders a slash command badge inline with text
 * Styled similarly to InlineBadge but indicates a SDK command (e.g., /compact)
 */
function CommandBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <span className="size-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[10px] font-medium">
        {COMMAND_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * ContextBadge - Renders a context badge that collapses hidden content
 * Shows collapsed label and hides the raw content from display
 * Note: edit_request badges are handled separately by EditRequestBadge
 */
function ContextBadge({ badge }: { badge: ContentBadge }) {
  const { t } = useTranslation()
  const displayLabel = badge.collapsedLabel || badge.label

  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mr-1 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
      title={t('chat.contextBadge')}
    >
      <span className="size-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[8px]">
        {CONTEXT_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px] text-muted-foreground">{displayLabel}</span>
    </span>
  )
}

/** Known code file extensions for picking the code file icon */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** Returns the appropriate file/folder SVG icon based on badge type and file extension */
function FileBadgeIcon({ badge }: { badge: ContentBadge }) {
  if (badge.type === 'folder') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
        <path d="M20.5 10C20.5 9.07 20.5 8.61 20.4 8.22C20.12 7.19 19.31 6.38 18.28 6.1C17.9 6 17.43 6 16.5 6H13.1C12.47 6 12.16 6 11.87 5.91C11.68 5.85 11.5 5.77 11.34 5.65C11.09 5.48 10.89 5.24 10.5 4.75L10.41 4.64C10.11 4.26 9.96 4.07 9.77 3.93C9.54 3.75 9.28 3.62 9 3.55C8.77 3.5 8.53 3.5 8.04 3.5C6.6 3.5 5.89 3.5 5.32 3.74C4.61 4.05 4.05 4.61 3.74 5.32C3.5 5.89 3.5 6.6 3.5 8.04V10M9.47 20.5H14.54C16.91 20.5 18.1 20.5 18.93 19.81C19.76 19.12 19.98 17.96 20.43 15.62L20.82 13.56C21.14 11.91 21.29 11.09 20.84 10.54C20.39 10 19.55 10 17.87 10H6.13C4.45 10 3.61 10 3.16 10.54C2.71 11.09 2.86 11.91 3.18 13.56L3.57 15.62C4.02 17.96 4.24 19.12 5.07 19.81C5.9 20.5 7.09 20.5 9.47 20.5Z"/>
      </svg>
    )
  }

  // Check if it's a code file
  const ext = badge.label.split('.').pop()?.toLowerCase()
  const isCode = ext ? CODE_EXTENSIONS.has(ext) : false

  if (isCode) {
    // Code file icon (document with < > brackets)
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
        <path d="M10.5 2.5C12.16 2.5 13.5 3.84 13.5 5.5V6.1C13.5 6.47 13.5 6.66 13.52 6.81C13.66 7.67 14.33 8.34 15.19 8.48C15.34 8.5 15.53 8.5 15.9 8.5H16.5C18.16 8.5 19.5 9.84 19.5 11.5M10.5 12.88C9.7 13.3 9.11 13.83 8.64 14.55C8.51 14.75 8.44 14.85 8.44 15C8.44 15.15 8.51 15.25 8.64 15.45C9.11 16.17 9.7 16.7 10.5 17.12M13.5 12.88C14.3 13.3 14.89 13.83 15.36 14.55C15.49 14.75 15.56 14.85 15.56 15C15.56 15.15 15.49 15.25 15.36 15.45C14.89 16.17 14.3 16.7 13.5 17.12M10.96 2.5H10.67C8.65 2.5 7.64 2.5 6.85 2.86C5.97 3.26 5.26 3.97 4.86 4.85C4.5 5.64 4.5 6.65 4.5 8.67V14C4.5 17.29 4.5 18.93 5.41 20.04C5.57 20.24 5.76 20.43 5.96 20.59C7.07 21.5 8.71 21.5 12 21.5C15.29 21.5 16.93 21.5 18.04 20.59C18.24 20.43 18.43 20.24 18.59 20.04C19.5 18.93 19.5 17.29 19.5 14V11.04C19.5 10 19.5 9.49 19.42 8.99C19.27 8.1 18.91 7.24 18.39 6.5C18.1 6.1 17.73 5.73 17 5C16.27 4.27 15.9 3.9 15.5 3.61C14.76 3.09 13.9 2.73 13.01 2.58C12.51 2.5 12 2.5 10.96 2.5Z"/>
      </svg>
    )
  }

  // Generic file icon (document with folded corner)
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
      <path d="M10.5 2.5C12.16 2.5 13.5 3.84 13.5 5.5V6.1C13.5 6.47 13.5 6.66 13.52 6.81C13.66 7.67 14.33 8.34 15.19 8.48C15.34 8.5 15.53 8.5 15.9 8.5H16.5C18.16 8.5 19.5 9.84 19.5 11.5M9 16H15M9 12H10M10.96 2.5H10.67C8.65 2.5 7.64 2.5 6.85 2.86C5.97 3.26 5.26 3.97 4.86 4.85C4.5 5.64 4.5 6.65 4.5 8.67V14C4.5 17.29 4.5 18.93 5.41 20.04C5.57 20.24 5.76 20.43 5.96 20.59C7.07 21.5 8.71 21.5 12 21.5C15.29 21.5 16.93 21.5 18.04 20.59C18.24 20.43 18.43 20.24 18.59 20.04C19.5 18.93 19.5 17.29 19.5 14V11.04C19.5 10 19.5 9.49 19.42 8.99C19.27 8.1 18.91 7.24 18.39 6.5C18.1 6.1 17.73 5.73 17 5C16.27 4.27 15.9 3.9 15.5 3.61C14.76 3.09 13.9 2.73 13.01 2.58C12.51 2.5 12 2.5 10.96 2.5Z"/>
    </svg>
  )
}

/**
 * InlineFileBadge - File/folder badge for inline display within text.
 * Shows proper icon (folder, code file, or generic file) with Tooltip for full path.
 * Optionally clickable when onFileClick is provided.
 */
function InlineFileBadge({
  badge,
  onFileClick
}: {
  badge: ContentBadge
  onFileClick?: (path: string) => void
}) {
  // Strip .craft-agent workspace/session path prefix for cleaner tooltip display
  // e.g. "/Users/.../workspaces/{id}/sessions/{id}/plans/foo.md" → "plans/foo.md"
  const rawPath = badge.filePath || badge.label
  const tooltipPath = normalizePath(rawPath).replace(/^.*\.craft-agent\/workspaces\/[^/]+\/(sessions\/[^/]+\/)?/, '')
  const isClickable = !!badge.filePath && !!onFileClick

  const badgeContent = (
    <span
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={() => isClickable && onFileClick!(badge.filePath!)}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onFileClick!(badge.filePath!) } : undefined}
      className={cn(
        "inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle",
        isClickable && "hover:bg-foreground/5 transition-colors cursor-pointer"
      )}
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <FileBadgeIcon badge={badge} />
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )

  // Wrap with Tooltip to show full path on hover
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badgeContent}
        </TooltipTrigger>
        <TooltipContent side="top">
          {tooltipPath}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Markdown classes for user message text.
 *
 * `whitespace-pre-wrap` preserves the soft line breaks the user actually
 * typed. The block margins that `Markdown`'s minimal mode emits (`my-2` on
 * paragraphs/lists/tables) are deliberately left intact so a user message
 * reads as rich markdown instead of one flat wall of text — the bubble must
 * not zero them out. First/last block margins collapse into the bubble
 * padding so a plain single-paragraph message stays tight.
 */
const MARKDOWN_BLOCK_CLASSES =
  'text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'

/** Same styling for text segments rendered inline between badges. */
const MARKDOWN_INLINE_CLASSES =
  'inline text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&_p]:inline'

/**
 * Render content with badges inserted at their positions.
 * Text segments between badges are rendered as Markdown.
 *
 * Context badges (type='context') are special:
 * - They completely hide the marked content range
 * - They show a collapsed badge with the collapsedLabel
 * - Used for EditPopover metadata that shouldn't be visible to users
 *
 * File badges (type='file') render inline as clickable badges:
 * - Used for plan execution messages where file path appears inline with text
 */
function renderContentWithBadges(
  content: string,
  badges: ContentBadge[],
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void,
  onResolveFilePath?: (path: string) => Promise<string | null>
): ReactNode {
  if (badges.length === 0) {
    return (
      <Markdown
        mode="minimal"
        onUrlClick={onUrlClick}
        onFileClick={onFileClick}
        onResolveFilePath={onResolveFilePath}
        className={MARKDOWN_BLOCK_CLASSES}
      >
        {content}
      </Markdown>
    )
  }

  // Sort badges by start position
  const sortedBadges = badges.toSorted((a, b) => a.start - b.start)

  const elements: ReactNode[] = []
  let lastEnd = 0

  sortedBadges.forEach((badge) => {
    // Add text before this badge
    if (badge.start > lastEnd) {
      const textBefore = content.slice(lastEnd, badge.start)
      if (textBefore.trim()) {
        elements.push(
          <Markdown
            key={`text-${badge.start}`}
            mode="minimal"
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
            onResolveFilePath={onResolveFilePath}
            className={MARKDOWN_INLINE_CLASSES}
          >
            {textBefore}
          </Markdown>
        )
      }
    }

    // Context badges hide content and show collapsed label
    // Command badges show SDK commands like /compact
    // File badges show clickable file references inline
    // Source/skill badges show inline with the original text
    // Note: edit_request badges are filtered out and rendered above the bubble separately
    if (badge.type === 'context') {
      elements.push(<ContextBadge key={`badge-${badge.start}`} badge={badge} />)
    } else if (badge.type === 'command') {
      elements.push(<CommandBadge key={`badge-${badge.start}`} badge={badge} />)
    } else if (badge.type === 'file' || badge.type === 'folder') {
      elements.push(<InlineFileBadge key={`badge-${badge.start}`} badge={badge} onFileClick={onFileClick} />)
    } else {
      elements.push(<InlineBadge key={`badge-${badge.start}`} badge={badge} />)
    }

    lastEnd = badge.end
  })

  // Add remaining text after last badge
  if (lastEnd < content.length) {
    const textAfter = content.slice(lastEnd)
    if (textAfter.trim()) {
      elements.push(
        <Markdown
          key="text-end"
          mode="minimal"
          onUrlClick={onUrlClick}
          onFileClick={onFileClick}
          onResolveFilePath={onResolveFilePath}
          className={MARKDOWN_INLINE_CLASSES}
        >
          {textAfter}
        </Markdown>
      )
    }
  }

  // Use <p> to match Markdown's block-level line-height behavior
  return <p className="text-sm">{elements}</p>
}

export interface UserMessageBubbleProps {
  /** Message content (markdown supported) */
  content: string
  /** Additional className for the outer container */
  className?: string
  /** Callback when a URL is clicked */
  onUrlClick?: (url: string) => void
  /** Callback when a file path is clicked */
  onFileClick?: (path: string) => void
  /** Resolve local file references before inline previews read them */
  onResolveFilePath?: (path: string) => Promise<string | null>
  /** Stored attachments (images, documents) */
  attachments?: StoredAttachment[]
  /** Content badges for inline display (sources, skills) */
  badges?: ContentBadge[]
  /** Whether the message is awaiting backend confirmation. User bubbles stay visually stable. */
  isPending?: boolean
  /** Whether the message is queued (badge shown) */
  isQueued?: boolean
  /** Compact mode - reduces padding for popover embedding */
  compactMode?: boolean
}

/** Minimum visible duration of the "Queued" chip. Both backends ack
 * mid-stream sends within ~50–150ms, which would otherwise make the chip
 * flash too briefly to register. Hold it long enough for the user to
 * actually read it. */
const QUEUED_MIN_VISIBLE_MS = 2500

export function UserMessageBubble({
  content,
  className,
  onUrlClick,
  onFileClick,
  onResolveFilePath,
  attachments,
  badges,
  isQueued,
  compactMode,
}: UserMessageBubbleProps) {
  const { t } = useTranslation()
  const hasAttachments = attachments && attachments.length > 0

  // Show the queued chip while `isQueued` is true AND for at least
  // QUEUED_MIN_VISIBLE_MS after it first became true — even if the backend
  // acks in <150ms. Pure UI state; `isQueued` remains the persisted source
  // of truth.
  const [showQueued, setShowQueued] = useState(isQueued ?? false)
  const queuedShownAtRef = useRef<number | null>(isQueued ? Date.now() : null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }

    if (isQueued) {
      setShowQueued(true)
      if (queuedShownAtRef.current === null) {
        queuedShownAtRef.current = Date.now()
      }
      return
    }

    // isQueued flipped to false. Keep the chip up for the remainder of
    // the minimum visible window, then clear.
    if (queuedShownAtRef.current === null) return

    const elapsed = Date.now() - queuedShownAtRef.current
    const remaining = Math.max(0, QUEUED_MIN_VISIBLE_MS - elapsed)

    if (remaining === 0) {
      setShowQueued(false)
      queuedShownAtRef.current = null
      return
    }

    clearTimerRef.current = setTimeout(() => {
      setShowQueued(false)
      queuedShownAtRef.current = null
      clearTimerRef.current = null
    }, remaining)
  }, [isQueued])

  // Separate edit_request badges (rendered above bubble) from other badges (rendered inline)
  const editRequestBadges = badges?.filter(isEditRequestBadge) ?? []
  const inlineBadges = badges?.filter(b => !isEditRequestBadge(b)) ?? []
  const hasEditRequestBadges = editRequestBadges.length > 0
  const hasInlineBadges = inlineBadges.length > 0

  // Strip edit_request content from the displayed text
  // Each badge has start/end positions marking where to remove content
  let displayContent = content
  if (hasEditRequestBadges) {
    // Sort badges by start position descending so we can remove from end to start
    // (this preserves positions for earlier removals)
    const sortedBadges = editRequestBadges.toSorted((a, b) => b.start - a.start)
    for (const badge of sortedBadges) {
      displayContent = displayContent.slice(0, badge.start) + displayContent.slice(badge.end)
    }
    displayContent = displayContent.trim()
  }

  return (
    <div className={cn("flex flex-col items-end gap-3 w-full", className)}>
      {/* Attachment preview row - stored attachments with thumbnails */}
      {hasAttachments && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {attachments!.map((att, i) => {
            const isImage = att.type === 'image'
            const hasThumbnail = !!att.thumbnailBase64

            return (
              <button
                key={att.id || i}
                type="button"
                className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity bg-transparent border-0 p-0 text-left"
                onClick={() => att.storedPath && onFileClick?.(att.storedPath)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') att.storedPath && onFileClick?.(att.storedPath) }}
                title={t('chat.clickToOpen', { name: att.name })}
              >
                {isImage ? (
                  /* IMAGE: Square thumbnail only */
                  <div className="size-14 rounded-[8px] overflow-hidden bg-background shadow-minimal">
                    {hasThumbnail ? (
                      <img
                        src={`data:image/png;base64,${att.thumbnailBase64}`}
                        alt={att.name}
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="size-full flex items-center justify-center">
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="size-5" />
                      </div>
                    )}
                  </div>
                ) : (
                  /* DOCUMENT: Bubble with thumbnail/icon + 2-line text */
                  <div className="flex items-center gap-2.5 rounded-[8px] bg-user-message-bubble pl-1.5 pr-3 py-1.5">
                    <div className="h-11 w-8 rounded-[6px] overflow-hidden bg-background shadow-minimal flex items-center justify-center shrink-0">
                      {hasThumbnail ? (
                        <img
                          src={`data:image/png;base64,${att.thumbnailBase64}`}
                          alt={att.name}
                          className="size-full object-cover object-top"
                        />
                      ) : (
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="size-5" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-[120px]">
                      <span className="text-xs font-medium line-clamp-2 break-all" title={att.name}>
                        {att.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {getFileTypeLabel(att.type, att.mimeType, att.name)}
                      </span>
                    </div>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Badges row - edit request badges above text bubble */}
      {hasEditRequestBadges && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {editRequestBadges.map((badge) => (
            <EditRequestBadge key={`edit-badge-${badge.start}`} badge={badge} />
          ))}
        </div>
      )}

      {/* Text content bubble. Queued messages render an inline header chip
          inside the bubble (Clock icon + 'Queued' italic) instead of a
          separate pill below — keeps the chat to one bubble per message
          while the chip and pulsing icon make the waiting state obvious
          (#616 follow-up). */}
      <div
        className={cn(
          "max-w-[80%] bg-user-message-bubble rounded-[16px] break-words min-w-0 select-text",
          compactMode ? "px-4 py-2" : "px-5 py-3.5"
        )}
      >
        {showQueued && (
          <div
            className="flex items-center gap-1.5 text-foreground/55 mb-1.5"
            role="status"
            aria-live="polite"
          >
            <Clock className="h-3 w-3 animate-pulse" aria-hidden="true" />
            <span className="text-[11px] italic">{t('chat.queuedBadge')}</span>
          </div>
        )}
        {hasInlineBadges
          ? renderContentWithBadges(displayContent, inlineBadges, onUrlClick, onFileClick, onResolveFilePath)
          : (
            <Markdown
              mode="minimal"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
              onResolveFilePath={onResolveFilePath}
              className={MARKDOWN_BLOCK_CLASSES}
            >
              {displayContent}
            </Markdown>
          )
        }
      </div>
    </div>
  )
}
