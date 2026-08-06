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
import { Table2 } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'

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
