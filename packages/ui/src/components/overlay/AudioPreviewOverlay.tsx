/**
 * AudioPreviewOverlay - In-app audio preview with transcript-ready controls.
 */

import * as React from 'react'
import { useEffect, useReducer } from 'react'
import { Music, PauseIcon, PlayIcon } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import {
  TranscriptViewerAudio,
  TranscriptViewerContainer,
  TranscriptViewerPlayPauseButton,
  TranscriptViewerScrubBar,
  TranscriptViewerWords,
  type CharacterAlignmentResponseModel,
} from '../ui/transcript-viewer'

const EMPTY_ALIGNMENT: CharacterAlignmentResponseModel = {
  characters: [],
  characterStartTimesSeconds: [],
  characterEndTimesSeconds: [],
}

export interface AudioPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  loadDataUrl: (path: string) => Promise<string>
  audioType?: string
  alignment?: CharacterAlignmentResponseModel
  theme?: 'light' | 'dark'
}

type AudioLoadState =
  | { status: 'idle' }
  | { status: 'loading'; forPath: string }
  | { status: 'loaded'; url: string; forPath: string }
  | { status: 'error'; message: string; forPath: string }

type AudioLoadAction =
  | { type: 'start'; forPath: string }
  | { type: 'loaded'; url: string; forPath: string }
  | { type: 'error'; message: string; forPath: string }

function audioLoadReducer(_state: AudioLoadState, action: AudioLoadAction): AudioLoadState {
  switch (action.type) {
    case 'start':
      return { status: 'loading', forPath: action.forPath }
    case 'loaded':
      return { status: 'loaded', url: action.url, forPath: action.forPath }
    case 'error':
      return { status: 'error', message: action.message, forPath: action.forPath }
  }
}

export function AudioPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  loadDataUrl,
  audioType,
  alignment,
  theme = 'light',
}: AudioPreviewOverlayProps) {
  const [loadState, dispatch] = useReducer(audioLoadReducer, { status: 'idle' })

  // Derive current-path values — stale entries are treated as absent
  const audioSrc = loadState.status === 'loaded' && loadState.forPath === filePath ? loadState.url : null
  const error = loadState.status === 'error' && loadState.forPath === filePath ? loadState.message : null
  const isLoading = loadState.status === 'loading' && loadState.forPath === filePath

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    dispatch({ type: 'start', forPath: filePath })

    loadDataUrl(filePath)
      .then((url) => {
        if (!cancelled) dispatch({ type: 'loaded', url, forPath: filePath })
      })
      .catch((err) => {
        if (!cancelled) dispatch({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load audio', forPath: filePath })
      })

    return () => { cancelled = true }
  }, [filePath, isOpen, loadDataUrl])

  const headerActions = (
    <CopyButton content={filePath} title="Copy path" className="bg-background shadow-minimal" />
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Music,
        label: 'Audio',
        variant: 'blue',
      }}
      filePath={filePath}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div className="flex min-h-[18rem] items-center justify-center p-4">
        <div className="w-full max-w-3xl">
          {isLoading && (
            <div className="rounded-[8px] border border-border/60 bg-card p-4">
              <div className="h-5 w-full animate-pulse rounded bg-foreground-10" />
              <div className="mt-3 h-5 w-1/2 animate-pulse rounded bg-foreground-10" />
              <div className="mt-6 h-2 w-full animate-pulse rounded bg-foreground-10" />
              <div className="mt-4 h-10 w-full animate-pulse rounded-[8px] bg-foreground-10" />
            </div>
          )}

          {audioSrc && (
            <TranscriptViewerContainer
              key={audioSrc}
              className="w-full rounded-[8px] border border-border/60 bg-card p-4 shadow-minimal"
              audioSrc={audioSrc}
              audioType={audioType ?? inferAudioMimeType(filePath)}
              alignment={alignment ?? EMPTY_ALIGNMENT}
            >
              <TranscriptViewerAudio className="sr-only" />
              <TranscriptViewerWords />
              <div className="flex items-center gap-3">
                <TranscriptViewerScrubBar />
              </div>
              <TranscriptViewerPlayPauseButton className="w-full cursor-pointer">
                {({ isPlaying }) => (
                  <>
                    {isPlaying ? (
                      <>
                        <PauseIcon className="size-4" /> Pause
                      </>
                    ) : (
                      <>
                        <PlayIcon className="size-4" /> Play
                      </>
                    )}
                  </>
                )}
              </TranscriptViewerPlayPauseButton>
            </TranscriptViewerContainer>
          )}
        </div>
      </div>
    </PreviewOverlay>
  )
}

function inferAudioMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'ogg':
    case 'oga':
      return 'audio/ogg'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    case 'm4a':
      return 'audio/mp4'
    case 'opus':
      return 'audio/opus'
    default:
      return 'audio/mpeg'
  }
}
