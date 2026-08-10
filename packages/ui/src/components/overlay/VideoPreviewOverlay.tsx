/**
 * VideoPreviewOverlay - In-app video playback for previewable video files.
 *
 * Streams over the media:// protocol rather than a data URL: a data URL would
 * force the whole file into memory before the first frame and make seeking
 * impossible, while media:// serves byte ranges so playback starts immediately
 * and the scrub bar works.
 */

import * as React from 'react'
import { Video } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'

export interface VideoPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  theme?: 'light' | 'dark'
}

/** Build the media:// URL the main-process protocol handler expects. */
export function buildVideoStreamUrl(filePath: string): string {
  return `media://workspace/${encodeURIComponent(filePath)}`
}

export function VideoPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  theme = 'light',
}: VideoPreviewOverlayProps) {
  const [error, setError] = React.useState<string | null>(null)

  // A new file gets a fresh <video>; otherwise a prior failure would stick.
  React.useEffect(() => {
    setError(null)
  }, [filePath])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Video,
        label: 'Video',
        variant: 'blue',
      }}
      filePath={filePath}
      error={error ? { label: 'Playback Failed', message: error } : undefined}
    >
      <div className="flex min-h-[18rem] items-center justify-center p-4">
        <video
          key={filePath}
          src={buildVideoStreamUrl(filePath)}
          controls
          autoPlay={false}
          className="max-h-full max-w-full rounded-[8px] shadow-minimal"
          onError={() => setError('This video could not be played. The codec may be unsupported.')}
        />
      </div>
    </PreviewOverlay>
  )
}
