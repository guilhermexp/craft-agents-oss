import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Archive, Bot, CalendarDays, Square, Trash2, Video } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { MeetingAskButton } from './MeetingAskButton'
import { shouldClearSelectedMeeting } from '@/lib/meetings-selection'
import { formatRecordingElapsed } from '@/lib/recording-elapsed'
import { meetingStatusLabelKey } from '@/lib/meeting-status-label'
import { cn } from '@/lib/utils'
import type { MeetingRecord } from '../../../shared/types'

export const MEETINGS_CHANGED_EVENT = 'craft:meetings-changed'

interface MeetingsListPanelProps {
  workspaceId?: string | null
  selectedMeetingId?: string | null
  onSelectMeeting: (record: MeetingRecord | null) => void
}

const MEETING_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function formatMeetingDate(value: number): string {
  return MEETING_DATE_FORMAT.format(new Date(value))
}

function getStatusLabel(record: MeetingRecord, t: (key: string) => string): string {
  return t(meetingStatusLabelKey(record))
}

function getCaptureLabel(record: MeetingRecord): string {
  return record.captureMode === 'craft' ? 'Craft' : 'Hermes'
}

function getTranscriptionLabel(record: MeetingRecord): string | null {
  if (!record.transcriptionProvider || !record.transcriptionModel) return null
  return `Deepgram ${record.transcriptionModel}`
}

export function MeetingsListPanel({ workspaceId, selectedMeetingId, onSelectMeeting }: MeetingsListPanelProps) {
  const { t } = useTranslation()
  const [records, setRecords] = React.useState<MeetingRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [stoppingId, setStoppingId] = React.useState<string | null>(null)
  const [actionId, setActionId] = React.useState<string | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [now, setNow] = React.useState<number>(() => Date.now())

  // Um único intervalo para o painel inteiro, vivo só enquanto há reunião ao
  // vivo — um timer por linha multiplicaria re-renders sem ganho.
  const hasLiveRecord = records.some(record => record.status === 'running' || record.status === 'starting')
  React.useEffect(() => {
    if (!hasLiveRecord) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [hasLiveRecord])

  // `silent` background refreshes must NOT toggle the global `loading` flag —
  // doing so triggers the `if (loading) return <Carregando/>` early-return, which
  // unmounts the whole list (and any open meeting popover) on every 5s poll.
  const loadMeetings = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!workspaceId) {
      setRecords([])
      setLoading(false)
      return
    }
    if (!options?.silent) setLoading(true)
    try {
      const next = await window.electronAPI.meetings.list(workspaceId)
      setRecords(next)
      setLoadFailed(false)
    } catch (error) {
      setLoadFailed(true)
      if (!options?.silent) {
        const message = error instanceof Error ? error.message : t('meetings.listError')
        toast.error(message)
      }
    } finally {
      if (!options?.silent) setLoading(false)
    }
  }, [t, workspaceId])

  React.useEffect(() => {
    void loadMeetings()
    const timer = window.setInterval(() => {
      void loadMeetings({ silent: true })
    }, 5_000)
    const handleMeetingsChanged = () => {
      void loadMeetings({ silent: true })
    }
    window.addEventListener(MEETINGS_CHANGED_EVENT, handleMeetingsChanged)
    window.addEventListener('focus', handleMeetingsChanged)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(MEETINGS_CHANGED_EVENT, handleMeetingsChanged)
      window.removeEventListener('focus', handleMeetingsChanged)
    }
  }, [loadMeetings])

  React.useEffect(() => {
    if (loading) return
    if (shouldClearSelectedMeeting(records, selectedMeetingId)) {
      onSelectMeeting(null)
    }
  }, [loading, onSelectMeeting, records, selectedMeetingId])

  const handleStop = async (record: MeetingRecord) => {
    if (!workspaceId) return
    setStoppingId(record.id)
    try {
      await window.electronAPI.meetings.stop(workspaceId, record.id)
      window.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.stopError')
      toast.error(message)
    } finally {
      setStoppingId(null)
    }
  }

  const handleArchive = async (record: MeetingRecord) => {
    if (!workspaceId) return
    if (!window.confirm(t('meetings.archiveConfirm'))) return
    setActionId(`archive:${record.id}`)
    try {
      await window.electronAPI.meetings.archive(workspaceId, record.id)
      if (selectedMeetingId === record.id) {
        onSelectMeeting(null)
      }
      window.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.archiveError')
      toast.error(message)
    } finally {
      setActionId(null)
    }
  }

  const handleDelete = async (record: MeetingRecord) => {
    if (!workspaceId) return
    if (!window.confirm(t('meetings.deleteConfirm'))) return
    setActionId(`delete:${record.id}`)
    try {
      await window.electronAPI.meetings.deleteMeeting(workspaceId, record.id)
      if (selectedMeetingId === record.id) {
        onSelectMeeting(null)
      }
      window.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.deleteError')
      toast.error(message)
    } finally {
      setActionId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 px-4 py-6 text-center text-xs text-muted-foreground">
        {t('common.loading', 'Carregando...')}
      </div>
    )
  }

  if (loadFailed && records.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm font-medium text-foreground">{t('meetings.listError')}</div>
        <Button variant="outline" size="sm" onClick={() => void loadMeetings()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border/70 bg-foreground/[0.025] text-muted-foreground">
          <CalendarDays className="size-5" />
        </div>
        <div className="text-sm font-medium text-foreground">{t('meetings.emptyRecordingsTitle', 'Nenhuma gravação')}</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('meetings.emptyRecordingsDescription', 'Gravações do Hermes e do recorder interno do Craft aparecerão aqui.')}
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div className="space-y-1">
        {records.map((record) => {
          const selected = selectedMeetingId === record.id
          const isLive = record.status === 'running' || record.status === 'starting'
          const CaptureIcon = record.captureMode === 'craft' ? Video : Bot
          const transcriptionLabel = getTranscriptionLabel(record)
          return (
            <div
              key={record.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectMeeting(record)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelectMeeting(record)
              }}
              className={cn(
                'group flex w-full min-w-0 flex-col gap-2 rounded-md px-2 py-2 text-left transition-colors',
                selected ? 'bg-foreground/[0.065]' : 'hover:bg-foreground/[0.035]'
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className={cn(
                  'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border',
                  isLive ? 'border-success/25 bg-success/10 text-success' : 'border-border/65 bg-background/45 text-muted-foreground'
                )}>
                  {record.status === 'error' ? <AlertCircle className="size-3.5" /> : <CaptureIcon className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium leading-5 text-foreground">
                    {record.title || record.code || 'Google Meet'}
                  </span>
                  <span className="block truncate text-xs leading-5 tabular-nums text-muted-foreground">
                    {formatMeetingDate(record.startedAt)} · {getCaptureLabel(record)} · {isLive
                      ? t('meetings.statusRunningWithElapsed', { elapsed: formatRecordingElapsed(now - record.startedAt) })
                      : getStatusLabel(record, t)}
                    {/* Enquanto ao vivo, o tempo ocupa o lugar do provedor de
                        transcrição: a linha já truncava com "…" antes do timer. */}
                    {!isLive && transcriptionLabel ? ` · ${transcriptionLabel}` : ''}
                  </span>
                </span>
              </div>
              {record.error && (
                <div className="line-clamp-2 rounded-md bg-destructive/8 px-2 py-1 text-xs leading-4 text-destructive">
                  {record.error}
                </div>
              )}
              {isLive ? (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-xs opacity-90"
                    disabled={stoppingId === record.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleStop(record)
                    }}
                  >
                    <Square className="size-3" />
                    {t('meetings.stopRecording', 'Parar')}
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end gap-1.5">
                  {workspaceId && (
                    <MeetingAskButton workspaceId={workspaceId} record={record} />
                  )}
                  {/* Só-ícone: três botões com rótulo apertavam a linha. O nome
                      acessível vive em aria-label + title, não no texto. */}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="size-7 p-0 opacity-90"
                    aria-label={t('meetings.archive')}
                    title={t('meetings.archive')}
                    disabled={actionId === `archive:${record.id}` || actionId === `delete:${record.id}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleArchive(record)
                    }}
                  >
                    <Archive className="size-3" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="size-7 p-0 text-destructive opacity-90 hover:text-destructive"
                    aria-label={t('meetings.delete')}
                    title={t('meetings.delete')}
                    disabled={actionId === `archive:${record.id}` || actionId === `delete:${record.id}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDelete(record)
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
