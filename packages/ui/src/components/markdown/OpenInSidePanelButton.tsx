/**
 * OpenInSidePanelButton - "open beside the chat" affordance for file-backed
 * markdown preview blocks, rendered next to each block's fullscreen button so
 * the user picks per file: big dialog or side panel.
 *
 * Renders nothing when the platform offers no side panel (web viewer, compact
 * layout) or when the block has no real file behind it - a data: URL or inline
 * rows have nothing a file tab could show.
 */

import { PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

export function OpenInSidePanelButton({
  src,
  alwaysVisible = false,
}: {
  src: string | undefined
  /** Mirror the sibling fullscreen button: shown on hover, or always for multi-item blocks. */
  alwaysVisible?: boolean
}) {
  const { t } = useTranslation()
  const { onOpenFileInSidePanel } = usePlatform()

  if (!onOpenFileInSidePanel || !src || src.startsWith('data:')) return null

  return (
    <button
      type="button"
      onClick={() => onOpenFileInSidePanel(src)}
      className={cn(
        'p-1 rounded-[6px] transition-all select-none',
        'bg-background shadow-minimal',
        'text-muted-foreground/50 hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
        alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
      title={t('preview.openInSidePanel')}
    >
      <PanelRight className="size-3.5" />
    </button>
  )
}
