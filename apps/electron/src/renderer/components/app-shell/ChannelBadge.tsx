/**
 * ChannelBadge
 *
 * Slack-style channel breadcrumb shown in the session header when a session
 * carries one or more channel-backed labels. Resolves matching channels by
 * comparing each session label's id (via `extractLabelId`) against the
 * `labelId` of every workspace channel.
 *
 * Click navigates to the corresponding channel view
 * (`routes.view.label(channel.labelId)`).
 *
 * Notes:
 * - If there are no channel matches, this renders `null`.
 * - Multiple matching channels render side-by-side (Slack also shows multiple
 *   channels in cross-posted threads), so callers don't need to limit upstream.
 * - This is a pure presentational component — channels are loaded once at the
 *   AppShell level and prop-drilled through context to keep things simple
 *   (no extra refetch per session view).
 */

import * as React from 'react'
import { Hash } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WarRoomChannel } from '@craft-agent/shared/channels'
import { extractLabelId } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'

export interface ChannelBadgeProps {
  /** Session labels (encoded entries like "bug" or "priority::3") */
  sessionLabels?: string[]
  /** All workspace channels (loaded once at AppShell level) */
  channels?: WarRoomChannel[]
  /** Optional className override */
  className?: string
}

/**
 * Resolve which channels are linked to the given session labels.
 * Exposed for testing and for callers that want to short-circuit when empty.
 */
function resolveSessionChannels(
  sessionLabels: string[] | undefined,
  channels: WarRoomChannel[] | undefined,
): WarRoomChannel[] {
  if (!sessionLabels?.length || !channels?.length) return []
  const labelIds = new Set(sessionLabels.map(extractLabelId))
  return channels.filter(channel => labelIds.has(channel.labelId))
}

interface SingleChannelBadgeProps {
  channel: WarRoomChannel
  ariaLabel: string
}

function SingleChannelBadge({ channel, ariaLabel }: SingleChannelBadgeProps) {
  const { isDark } = useTheme()
  const color = channel.color ? resolveEntityColor(channel.color, isDark) : null

  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      navigate(routes.view.label(channel.labelId))
    },
    [channel.labelId],
  )

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel}
      title={`#${channel.name}`}
      className={cn(
        'titlebar-no-drag inline-flex items-center gap-0.5 h-[20px] px-1.5 rounded-md',
        'text-[11px] font-medium leading-none whitespace-nowrap max-w-[140px]',
        'transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      style={
        color
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
              color: `color-mix(in srgb, ${color} 80%, var(--foreground))`,
            }
          : {
              backgroundColor: 'rgba(var(--foreground-rgb), 0.05)',
              color: 'rgba(var(--foreground-rgb), 0.85)',
            }
      }
    >
      <Hash className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate min-w-0">{channel.name}</span>
    </button>
  )
}

/**
 * ChannelBadge renders a small `#channel-name` chip (or list of chips) for
 * each workspace channel that matches one of the session's labels. Returns
 * `null` when no match is found, so it's safe to drop into a header without
 * conditional wrappers.
 */
export function ChannelBadge({ sessionLabels, channels, className }: ChannelBadgeProps) {
  const { t } = useTranslation()
  const matches = React.useMemo(
    () => resolveSessionChannels(sessionLabels, channels),
    [sessionLabels, channels],
  )

  if (matches.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1 min-w-0', className)}>
      {matches.map(channel => (
        <SingleChannelBadge
          key={channel.id}
          channel={channel}
          ariaLabel={t('chat.openChannel', { name: channel.name })}
        />
      ))}
    </div>
  )
}
