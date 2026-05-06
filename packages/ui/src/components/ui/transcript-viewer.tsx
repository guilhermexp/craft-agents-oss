import * as React from 'react'
import { cn } from '../../lib/utils'

export interface CharacterAlignmentResponseModel {
  characters: string[]
  characterStartTimesSeconds: number[]
  characterEndTimesSeconds: number[]
}

interface TranscriptViewerContextValue {
  audioRef: React.RefObject<HTMLAudioElement>
  audioSrc: string
  audioType?: string
  alignment: CharacterAlignmentResponseModel
  currentTime: number
  duration: number
  isPlaying: boolean
  togglePlayback: () => void
  seek: (seconds: number) => void
}

const TranscriptViewerContext = React.createContext<TranscriptViewerContextValue | null>(null)

function useTranscriptViewer(): TranscriptViewerContextValue {
  const context = React.useContext(TranscriptViewerContext)
  if (!context) {
    throw new Error('Transcript viewer components must be rendered inside TranscriptViewerContainer')
  }
  return context
}

export interface TranscriptViewerContainerProps extends React.HTMLAttributes<HTMLElement> {
  audioSrc: string
  audioType?: string
  alignment: CharacterAlignmentResponseModel
  as?: 'div' | 'span'
}

export function TranscriptViewerContainer({
  audioSrc,
  audioType,
  alignment,
  as: Component = 'div',
  className,
  children,
  ...props
}: TranscriptViewerContainerProps) {
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [isPlaying, setIsPlaying] = React.useState(false)

  React.useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleLoadedMetadata = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime)
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleEnded = () => setIsPlaying(false)

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('durationchange', handleLoadedMetadata)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)

    handleLoadedMetadata()
    handleTimeUpdate()

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('durationchange', handleLoadedMetadata)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [audioSrc])

  const togglePlayback = React.useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    if (audio.paused) {
      void audio.play()
    } else {
      audio.pause()
    }
  }, [])

  const seek = React.useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(seconds, duration || seconds))
    setCurrentTime(audio.currentTime)
  }, [duration])

  const value = React.useMemo<TranscriptViewerContextValue>(() => ({
    audioRef,
    audioSrc,
    audioType,
    alignment,
    currentTime,
    duration,
    isPlaying,
    togglePlayback,
    seek,
  }), [audioSrc, audioType, alignment, currentTime, duration, isPlaying, seek, togglePlayback])

  return (
    <TranscriptViewerContext.Provider value={value}>
      <Component className={cn('flex w-full flex-col gap-4', className)} {...props}>
        {children}
      </Component>
    </TranscriptViewerContext.Provider>
  )
}

export type TranscriptViewerAudioProps = Omit<React.AudioHTMLAttributes<HTMLAudioElement>, 'src'>

export function TranscriptViewerAudio({ className, ...props }: TranscriptViewerAudioProps) {
  const { audioRef, audioSrc, audioType } = useTranscriptViewer()

  return (
    <audio ref={audioRef} className={className} preload="metadata" {...props}>
      <source src={audioSrc} type={audioType} />
    </audio>
  )
}

export interface TranscriptViewerPlayPauseButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: (state: { isPlaying: boolean }) => React.ReactNode
  size?: 'sm' | 'default'
}

export function TranscriptViewerPlayPauseButton({
  children,
  className,
  size = 'default',
  type = 'button',
  onClick,
  ...props
}: TranscriptViewerPlayPauseButtonProps) {
  const { isPlaying, togglePlayback } = useTranscriptViewer()

  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[8px] border border-border/60 bg-foreground text-background font-medium shadow-minimal transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) togglePlayback()
      }}
      {...props}
    >
      {children({ isPlaying })}
    </button>
  )
}

export interface TranscriptViewerScrubBarProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'min' | 'max' | 'value' | 'onChange'> {}

export function TranscriptViewerScrubBar({ className, ...props }: TranscriptViewerScrubBarProps) {
  const { currentTime, duration, seek } = useTranscriptViewer()
  const max = duration > 0 ? duration : 0

  return (
    <input
      type="range"
      min={0}
      max={max || 1}
      step={0.01}
      value={max ? currentTime : 0}
      disabled={!max}
      aria-label="Audio position"
      className={cn('h-2 w-full cursor-pointer accent-foreground disabled:cursor-not-allowed disabled:opacity-50', className)}
      onChange={(event) => seek(Number(event.currentTarget.value))}
      {...props}
    />
  )
}

export interface TranscriptViewerWordsProps extends React.HTMLAttributes<HTMLDivElement> {
  emptyLabel?: string
}

export function TranscriptViewerWords({ className, emptyLabel = 'No transcript available', ...props }: TranscriptViewerWordsProps) {
  const { alignment, currentTime, seek } = useTranscriptViewer()
  const words = React.useMemo(() => buildAlignedWords(alignment), [alignment])

  if (words.length === 0) {
    return (
      <div className={cn('rounded-[8px] border border-border/60 bg-foreground-2 px-3 py-2 text-sm text-muted-foreground', className)} {...props}>
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className={cn('max-h-56 overflow-y-auto rounded-[8px] border border-border/60 bg-foreground-2 p-3 text-sm leading-7', className)} {...props}>
      {words.map((word, index) => {
        const isActive = currentTime >= word.start && currentTime <= word.end
        return (
          <button
            key={`${word.text}-${index}-${word.start}`}
            type="button"
            className={cn(
              'mr-1 rounded px-1 py-0.5 text-left transition-colors',
              isActive ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-foreground-5'
            )}
            onClick={() => seek(word.start)}
          >
            {word.text}
          </button>
        )
      })}
    </div>
  )
}

interface AlignedWord {
  text: string
  start: number
  end: number
}

function buildAlignedWords(alignment: CharacterAlignmentResponseModel): AlignedWord[] {
  const words: AlignedWord[] = []
  let text = ''
  let start: number | null = null
  let end = 0

  alignment.characters.forEach((character, index) => {
    const charStart = alignment.characterStartTimesSeconds[index]
    const charEnd = alignment.characterEndTimesSeconds[index]
    const safeStart = typeof charStart === 'number' && Number.isFinite(charStart) ? charStart : 0
    const safeEnd = typeof charEnd === 'number' && Number.isFinite(charEnd) ? charEnd : safeStart
    const isWhitespace = /\s/.test(character)

    if (isWhitespace) {
      if (text && start !== null) {
        words.push({ text, start, end })
      }
      text = ''
      start = null
      end = 0
      return
    }

    if (start === null) start = safeStart
    end = safeEnd
    text += character
  })

  if (text && start !== null) {
    words.push({ text, start, end })
  }

  return words
}
