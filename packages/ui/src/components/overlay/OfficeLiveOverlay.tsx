/**
 * OfficeLiveOverlay - Fullscreen view of an editable Office document.
 *
 * Frames the loopback `officecli watch` server rather than rendered HTML: the
 * double-click cell editor, the formula engine and the sheet tabs all live in
 * the served page, so a snapshot would be read-only.
 *
 * The frame carries no `sandbox` attribute on purpose — the served page needs
 * its own origin for its fetch/SSE calls, and the renderer's `frame-src` CSP
 * already limits framing to loopback.
 */

import * as React from 'react'
import { ChevronsRight, Table2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PreviewOverlay } from './PreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

export interface OfficeLiveOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  /** Loopback URL of the live server, or null while it starts. */
  url: string | null
  error?: string
  theme?: 'light' | 'dark'
}

export function OfficeLiveOverlay({
  isOpen,
  onClose,
  filePath,
  url,
  error,
  theme = 'light',
}: OfficeLiveOverlayProps) {
  const { t } = useTranslation()
  const { onOpenFileInSidePanel } = usePlatform()

  // Same document, narrower surface. Closing the overlay first avoids leaving
  // the file open in two places at once — one live server, one view.
  const openBeside = React.useCallback(() => {
    onOpenFileInSidePanel?.(filePath)
    onClose()
  }, [onOpenFileInSidePanel, filePath, onClose])

  const headerActions = onOpenFileInSidePanel ? (
    <button
      type="button"
      onClick={openBeside}
      className={cn(
        'flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs transition-colors',
        'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      title={t('preview.openInSidePanel')}
    >
      <ChevronsRight className="size-3.5" />
      {t('preview.openInSidePanel')}
    </button>
  ) : undefined

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Table2,
        label: 'Document',
        variant: 'green',
      }}
      filePath={filePath}
      error={error ? { label: 'Open Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      {url ? (
        <iframe
          title={filePath.split('/').pop() ?? 'Document'}
          src={url}
          className="h-full min-h-[32rem] w-full border-0 bg-white"
        />
      ) : (
        !error && (
          <div className="flex min-h-[18rem] items-center justify-center p-4">
            <div className="h-5 w-40 animate-pulse rounded bg-foreground-10" />
          </div>
        )
      )}
    </PreviewOverlay>
  )
}
