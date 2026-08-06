import { memo, useState } from "react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SessionStatusMenu } from "@/components/ui/session-status-menu"
import { getStateIcon, getStateIconStyle } from "@/config/session-status-config"
import { useSessionListActions } from "@/context/SessionListContext"
import type { SessionMeta } from "@/atoms/sessions"
import { getSessionStatus } from "@/utils/session"

interface SessionStatusIconProps {
  item: SessionMeta
}

/**
 * Mounts a Radix `Popover` per session row. Reads only the stable actions
 * context and is memoized on `item`, whose identity survives unrelated writes
 * to the session meta map — otherwise every keystroke in the search box
 * re-rendered one popover per row.
 */
export const SessionStatusIcon = memo(function SessionStatusIcon({ item }: SessionStatusIconProps) {
  const ctx = useSessionListActions()
  const [open, setOpen] = useState(false)
  const status = getSessionStatus(item)

  const handleSelect = (state: import("@/config/session-status-config").SessionStatusId) => {
    setOpen(false)
    ctx.onSessionStatusChange(item.id, state)
  }

  return (
    <Popover modal={true} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          className={cn(
            "!h-5 !w-5 flex items-center justify-center rounded-full transition-colors cursor-pointer",
            "hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "[&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-base",
          )}
          style={getStateIconStyle(status, ctx.sessionStatuses)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Change todo state"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              setOpen((prev) => !prev)
            }
          }}
          onMouseDown={(e) => {
            // Block parent EntityRow's onMouseDown (session select) so clicking
            // the status icon only toggles the popover.
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {getStateIcon(status, ctx.sessionStatuses)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        align="start"
        side="bottom"
        sideOffset={4}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <SessionStatusMenu
          activeState={status}
          onSelect={handleSelect}
          states={ctx.sessionStatuses}
          isArchived={item.isArchived}
          onArchive={ctx.onArchive ? () => { setOpen(false); ctx.onArchive!(item.id) } : undefined}
          onUnarchive={ctx.onUnarchive ? () => { setOpen(false); ctx.onUnarchive!(item.id) } : undefined}
        />
      </PopoverContent>
    </Popover>
  )
})
