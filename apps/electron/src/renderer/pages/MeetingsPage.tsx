import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  HelpCircle,
  Loader2,
  MessageSquareText,
  Mic,
  Settings,
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { MEETINGS_CHANGED_EVENT } from '@/components/app-shell/MeetingsListPanel'
import { cn } from '@/lib/utils'
import type { BrowserInstanceInfo, MeetingRecord, MeetingStartInput, MeetingTranscriptResult } from '../../shared/types'

const GOOGLE_MEET_PREFIX = 'https://meet.google.com/'

type MeetingTranscriptionProvider = NonNullable<MeetingStartInput['transcriptionProvider']>
type MeetingDetailTab = 'summary' | 'transcript'
type MeetingsSection = 'invite' | 'results'

interface TranscriptionModelOption {
  id: string
  label: string
}

const TRANSCRIPTION_MODELS: Record<MeetingTranscriptionProvider, TranscriptionModelOption[]> = {
  deepgram: [
    { id: 'nova-3', label: 'Nova 3' },
    { id: 'nova-2', label: 'Nova 2' },
  ],
}

function getTranscriptionProviderLabel(provider: MeetingTranscriptionProvider): string {
  return 'Deepgram'
}

function normalizeGoogleMeetInput(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname === 'meet.google.com') {
        const detected = extractGoogleMeetMeetingUrl(url.toString())
        return detected ?? url.toString()
      }
      if (url.hostname.endsWith('.google.com') && url.pathname.includes('/meet/')) return url.toString()
      return raw
    } catch {
      return raw
    }
  }

  const code = raw
    .replace(/^meet\.google\.com\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()

  if (!code) return null
  return `${GOOGLE_MEET_PREFIX}${code}`
}

function extractGoogleMeetMeetingUrl(value: string | undefined | null): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    if (url.hostname !== 'meet.google.com') return null

    const match = url.pathname.toLowerCase().match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/)
    if (!match) return null

    return `${GOOGLE_MEET_PREFIX}${match[1]}`
  } catch {
    const match = value.toLowerCase().match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/)
    return match ? `${GOOGLE_MEET_PREFIX}${match[1]}` : null
  }
}

function extractGoogleMeetMeetingUrlFromBrowserInfo(info: BrowserInstanceInfo): string | null {
  return extractGoogleMeetMeetingUrl(info.url) ?? extractGoogleMeetMeetingUrl(info.title)
}

interface MeetingOptionProps {
  checked: boolean
  onChange: (checked: boolean) => void
  icon: React.ReactNode
  title: string
  description: string
}

function MeetingOption({ checked, onChange, icon, title, description }: MeetingOptionProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onChange(!checked)
        }
      }}
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20',
        checked
          ? 'border-foreground/15 bg-foreground/[0.045] text-foreground'
          : 'border-border/55 bg-transparent text-muted-foreground hover:border-border hover:bg-foreground/[0.025]'
      )}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors',
          checked
            ? 'border-foreground/15 bg-background/80 text-foreground'
            : 'border-border/60 bg-background/35 text-muted-foreground group-hover:text-foreground/80'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-5 text-foreground">{title}</span>
        <span className="block line-clamp-2 text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <Switch className="ml-1" checked={checked} onCheckedChange={onChange} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}

function ProcessStep({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/55 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}

function ProcessingPipeline({
  record,
  transcript,
  t,
}: {
  record: MeetingRecord | null
  transcript: MeetingTranscriptResult | null
  t: (key: string, options?: { defaultValue?: string }) => string
}) {
  if (!record) return null

  const recordingDone = Boolean(record.recording?.path)
  const transcriptionActive = transcript?.status === 'capturing'
  const transcriptionDone = transcript?.status === 'ready'
  const transcriptionUnavailable = transcript?.status === 'unavailable'
  const waitingForRecording = record.status === 'running' || record.status === 'starting' || (!recordingDone && record.captureMode === 'craft')
  const steps = [
    {
      key: 'recording',
      title: t('meetings.pipelineRecording', { defaultValue: 'Gravação' }),
      description: recordingDone
        ? t('meetings.pipelineRecordingSaved', { defaultValue: 'Arquivo WebM salvo no workspace.' })
        : waitingForRecording
          ? t('meetings.pipelineRecordingActive', { defaultValue: 'Capturando a reunião no Craft.' })
          : t('meetings.pipelineRecordingPending', { defaultValue: 'Aguardando o arquivo de gravação.' }),
      state: recordingDone ? 'done' : waitingForRecording ? 'active' : 'pending',
    },
    {
      key: 'transcription',
      title: t('meetings.pipelineTranscription', { defaultValue: 'Transcrição' }),
      description: transcriptionDone
        ? t('meetings.pipelineTranscriptionDone', { defaultValue: 'Markdown da transcrição disponível.' })
        : transcriptionActive
          ? t('meetings.pipelineTranscriptionActive', { defaultValue: 'Enviando o áudio para transcrição.' })
          : transcriptionUnavailable
            ? transcript?.message || t('meetings.pipelineTranscriptionUnavailable', { defaultValue: 'Transcrição indisponível.' })
            : t('meetings.pipelineTranscriptionPending', { defaultValue: 'Aguardando a gravação finalizar.' }),
      state: transcriptionDone ? 'done' : transcriptionActive ? 'active' : transcriptionUnavailable ? 'error' : 'pending',
    },
    {
      key: 'markdown',
      title: t('meetings.pipelineMarkdown', { defaultValue: 'Markdown' }),
      description: transcriptionDone
        ? t('meetings.pipelineMarkdownDone', { defaultValue: 'Resumo e aba de transcrição foram atualizados.' })
        : transcriptionUnavailable
          ? t('meetings.pipelineMarkdownUnavailable', { defaultValue: 'Revise o erro antes de gerar entregáveis.' })
          : t('meetings.pipelineMarkdownPending', { defaultValue: 'Será atualizado quando a transcrição terminar.' }),
      state: transcriptionDone ? 'done' : transcriptionUnavailable ? 'error' : 'pending',
    },
  ] as const

  return (
    <div className="mb-3 grid gap-2 md:grid-cols-3">
      {steps.map((step) => (
        <div key={step.key} className="rounded-lg border border-border/60 bg-background/35 p-3">
          <div className="flex items-center gap-2">
            <span className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-md border',
              step.state === 'done' && 'border-success/25 bg-success/10 text-success',
              step.state === 'active' && 'border-foreground/20 bg-foreground/[0.06] text-foreground',
              step.state === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
              step.state === 'pending' && 'border-border/70 bg-background/45 text-muted-foreground'
            )}>
              {step.state === 'active' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : step.state === 'done' ? (
                <CheckCircle2 className="size-3.5" />
              ) : step.state === 'error' ? (
                <AlertCircle className="size-3.5" />
              ) : (
                <FileText className="size-3.5" />
              )}
            </span>
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{step.title}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{step.description}</p>
        </div>
      ))}
    </div>
  )
}

interface MeetingsPageProps {
  workspaceId?: string | null
  selectedMeetingId?: string | null
}

function buildFallbackSummary(
  record: MeetingRecord | null,
  transcript: MeetingTranscriptResult | null,
  emptyPlaceholder: string,
): string {
  if (transcript?.summaryMarkdown) return transcript.summaryMarkdown
  if (record?.summaryMarkdown) return record.summaryMarkdown
  if (!record) return emptyPlaceholder

  const origin = record.captureMode === 'craft' ? 'Craft internal' : 'Hermes'
  const status = record.status
  const lines = [
    `# ${record.title || 'Google Meet'}`,
    '',
    `- Origem: ${origin}`,
    `- Status: ${status}`,
    `- Link: ${record.url}`,
  ]
  if (record.transcriptionProvider && record.transcriptionModel) {
    lines.push(`- Transcricao: ${getTranscriptionProviderLabel(record.transcriptionProvider)} / ${record.transcriptionModel}`)
  }
  lines.push(
    '',
    '## Resumo',
    '',
    transcript?.message || 'Summary not yet available for this recording.',
  )
  return lines.join('\n')
}

function formatTranscriptTimestamp(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '00:00'
  const totalSeconds = Math.floor(value / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function buildTranscriptMarkdown(
  record: MeetingRecord | null,
  transcript: MeetingTranscriptResult | null,
  unavailableText: string,
): string {
  if (!record) return unavailableText

  const lines = [
    `# ${record.title || record.code || 'Google Meet'}`,
    '',
    `- Link: ${record.url}`,
    `- Status: ${record.status}`,
    `- Capture: ${record.captureMode === 'craft' ? 'Craft' : 'Hermes'}`,
  ]

  if (record.recording?.durationMs) {
    lines.push(`- Duration: ${formatTranscriptTimestamp(record.recording.durationMs)}`)
  }

  lines.push('', '## Transcript', '')

  if (!transcript || transcript.transcript.length === 0) {
    lines.push(transcript?.message || unavailableText)
    return lines.join('\n')
  }

  for (const segment of transcript.transcript) {
    const speaker = segment.speaker?.trim() || 'Speaker'
    const timestamp = formatTranscriptTimestamp(segment.startedAt ?? segment.timestamp)
    lines.push(`**[${timestamp}] ${speaker}:** ${segment.text}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

export function MeetingsPage({ workspaceId, selectedMeetingId }: MeetingsPageProps) {
  const { t } = useTranslation()
  const [meetingInput, setMeetingInput] = useState('')
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(true)
  const [transcriptionProvider, setTranscriptionProvider] = useState<MeetingTranscriptionProvider>('deepgram')
  const [transcriptionModel, setTranscriptionModel] = useState(TRANSCRIPTION_MODELS.deepgram[0]?.id ?? 'nova-3')
  const [hasTranscriptionApiKey, setHasTranscriptionApiKey] = useState(false)
  const [transcriptionApiKeyDraft, setTranscriptionApiKeyDraft] = useState('')
  const [isLoadingTranscriptionSettings, setIsLoadingTranscriptionSettings] = useState(false)
  const [isSavingTranscriptionSettings, setIsSavingTranscriptionSettings] = useState(false)
  const [summaryEnabled, setSummaryEnabled] = useState(true)
  const [followUpEnabled, setFollowUpEnabled] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [isCraftRecording, setIsCraftRecording] = useState(false)
  const [selectedRecord, setSelectedRecord] = useState<MeetingRecord | null>(null)
  const [selectedTranscript, setSelectedTranscript] = useState<MeetingTranscriptResult | null>(null)
  const [selectedDetailTab, setSelectedDetailTab] = useState<MeetingDetailTab>('summary')
  const [activeSection, setActiveSection] = useState<MeetingsSection>('invite')
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [detectedMeeting, setDetectedMeeting] = useState<{ url: string; instanceId: string; profileId?: string; title?: string } | null>(null)
  const promptedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const launchedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const normalizedUrl = useMemo(() => normalizeGoogleMeetInput(meetingInput), [meetingInput])
  const canJoin = !!workspaceId && !!normalizedUrl && !isJoining
  const currentTranscriptionModels = TRANSCRIPTION_MODELS[transcriptionProvider]

  const handleTranscriptionProviderChange = (value: string) => {
    const provider: MeetingTranscriptionProvider = 'deepgram'
    setTranscriptionProvider(provider)
    setTranscriptionModel(TRANSCRIPTION_MODELS[provider][0]?.id ?? '')
    setHasTranscriptionApiKey(false)
  }

  React.useEffect(() => {
    if (!workspaceId) {
      setHasTranscriptionApiKey(false)
      setTranscriptionApiKeyDraft('')
      return
    }

    let cancelled = false
    setIsLoadingTranscriptionSettings(true)
    void window.electronAPI.meetings.getTranscriptionConfig(workspaceId)
      .then((config) => {
        if (cancelled) return
        setTranscriptionProvider(config.provider)
        setTranscriptionModel(config.model)
        setHasTranscriptionApiKey(config.hasApiKey)
        setTranscriptionApiKeyDraft('')
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : t('meetings.configLoadError')
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTranscriptionSettings(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const handleSaveTranscriptionSettings = async () => {
    if (!workspaceId) {
      toast.error(t('meetings.noWorkspaceForConfig'))
      return
    }

    setIsSavingTranscriptionSettings(true)
    try {
      const apiKey = transcriptionApiKeyDraft.trim()
      const config = await window.electronAPI.meetings.saveTranscriptionConfig(workspaceId, {
        provider: transcriptionProvider,
        model: transcriptionModel,
        ...(apiKey ? { apiKey } : {}),
      })
      setTranscriptionProvider(config.provider)
      setTranscriptionModel(config.model)
      setHasTranscriptionApiKey(config.hasApiKey)
      setTranscriptionApiKeyDraft('')
      toast.success(t('meetings.configSaved'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.configSaveError')
      toast.error(message)
    } finally {
      setIsSavingTranscriptionSettings(false)
    }
  }

  const handleGoogleAuth = async () => {
    // Let Google own the auth flow. Opening Meet itself is more reliable than
    // constructing accounts.google.com URLs, which can reject embedded/partial
    // login parameters with 400s. If the user is signed out, Meet redirects to
    // Google's login; if signed in, it lands on Meet with the active account.
    const authUrl = normalizedUrl || 'https://meet.google.com/'
    setIsAuthenticating(true)
    try {
      if (window.electronAPI.browserPane?.create) {
        await window.electronAPI.browserPane.create({ show: true, url: authUrl })
        toast.success(t('meetings.authOpened'))
        return
      }

      await window.electronAPI.openUrl(authUrl)
      toast.success(t('meetings.authOpened'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.authError')
      toast.error(message)
    } finally {
      setIsAuthenticating(false)
    }
  }

  React.useEffect(() => {
    setSelectedDetailTab('summary')
    if (selectedMeetingId) setActiveSection('results')
  }, [selectedMeetingId])

  React.useEffect(() => {
    if (!workspaceId || !selectedMeetingId) {
      setSelectedRecord(null)
      setSelectedTranscript(null)
      return
    }

    let cancelled = false
    const loadSelectedMeeting = async () => {
      try {
        const [record, transcript] = await Promise.all([
          window.electronAPI.meetings.status(workspaceId, selectedMeetingId),
          window.electronAPI.meetings.transcript(workspaceId, selectedMeetingId),
        ])
        if (cancelled) return
        setSelectedRecord(record)
        setSelectedTranscript(transcript)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : t('meetings.joinError')
        toast.error(message)
      }
    }

    void loadSelectedMeeting()
    const handleChanged = () => { void loadSelectedMeeting() }
    window.addEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
    const fallback = window.setInterval(() => { void loadSelectedMeeting() }, 1_500)
    return () => {
      cancelled = true
      window.removeEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
      window.clearInterval(fallback)
    }
  }, [selectedMeetingId, t, workspaceId])

  const startHermesForMeet = React.useCallback(async (
    meetingUrl: string,
    options?: { profileId?: string; browserInstanceId?: string; captureMode?: 'hermes' | 'craft' }
  ) => {
    const request: MeetingStartInput = {
      urlOrCode: meetingUrl,
      captureMode: options?.captureMode ?? 'hermes',
      profileId: options?.profileId,
      browserInstanceId: options?.browserInstanceId,
      title: 'Google Meet',
      transcribe: transcriptionEnabled,
      transcriptionProvider: transcriptionEnabled ? transcriptionProvider : undefined,
      transcriptionModel: transcriptionEnabled ? transcriptionModel : undefined,
      summarizeOnEnd: summaryEnabled,
      followUpOnEnd: followUpEnabled,
    }

    setIsJoining(true)
    try {
      const meetingsApi = window.electronAPI.meetings
      if (!meetingsApi?.start) {
        throw new Error(t('meetings.agentApiUnavailable'))
      }
      if (!workspaceId) {
        throw new Error(t('meetings.noWorkspaceForRecording'))
      }

      const result: MeetingRecord = await meetingsApi.start(workspaceId, request)
      if (result.status === 'error') throw new Error(result.error || t('meetings.joinError'))
      launchedMeetUrlsRef.current.add(meetingUrl)
      setDetectedMeeting((current) => current?.url === meetingUrl ? null : current)
      window.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT))
      toast.success(request.captureMode === 'craft' ? t('meetings.craftRecordStarted') : t('meetings.agentInvited'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.joinError')
      toast.error(message)
    } finally {
      setIsJoining(false)
    }
  }, [followUpEnabled, summaryEnabled, t, transcriptionEnabled, transcriptionModel, transcriptionProvider, workspaceId])

  const handleDetectedBrowserMeeting = React.useCallback((info: BrowserInstanceInfo) => {
    const meetingUrl = extractGoogleMeetMeetingUrlFromBrowserInfo(info)
    if (!meetingUrl) return
    if (launchedMeetUrlsRef.current.has(meetingUrl)) return
    if (promptedMeetUrlsRef.current.has(meetingUrl)) return

    promptedMeetUrlsRef.current.add(meetingUrl)
    setMeetingInput(meetingUrl)
    setDetectedMeeting({ url: meetingUrl, instanceId: info.id, profileId: info.profileId, title: info.title })
    toast.info(t('meetings.detectedToast'))
  }, [t])

  React.useEffect(() => {
    void window.electronAPI.browserPane?.list?.().then((instances: BrowserInstanceInfo[]) => {
      for (const info of instances) {
        handleDetectedBrowserMeeting(info)
      }
    }).catch(() => {
      // Browser pane list is opportunistic; the live listener below is the primary path.
    })

    const unsubscribe = window.electronAPI.browserPane?.onStateChanged?.(handleDetectedBrowserMeeting)

    const handleFocus = () => {
      void window.electronAPI.browserPane?.list?.().then((instances: BrowserInstanceInfo[]) => {
        for (const info of instances) {
          handleDetectedBrowserMeeting(info)
        }
      }).catch(() => {})
    }

    window.addEventListener('focus', handleFocus)

    return () => {
      unsubscribe?.()
      window.removeEventListener('focus', handleFocus)
    }
  }, [handleDetectedBrowserMeeting])

  const handleApproveDetectedMeeting = async () => {
    if (!detectedMeeting) return
    await startHermesForMeet(detectedMeeting.url, {
      profileId: detectedMeeting.profileId,
      browserInstanceId: detectedMeeting.instanceId,
    })
  }

  const handleDismissDetectedMeeting = () => {
    if (detectedMeeting) {
      launchedMeetUrlsRef.current.add(detectedMeeting.url)
    }
    setDetectedMeeting(null)
  }

  const handleJoin = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!normalizedUrl) {
      toast.error(t('meetings.invalidInput'))
      return
    }

    await startHermesForMeet(normalizedUrl)
  }

  const handleCraftRecord = async () => {
    if (!normalizedUrl) {
      toast.error(t('meetings.invalidInput'))
      return
    }

    setIsCraftRecording(true)
    try {
      await startHermesForMeet(normalizedUrl, { captureMode: 'craft' })
    } finally {
      setIsCraftRecording(false)
    }
  }

  const selectedSummaryMarkdown = buildFallbackSummary(
    selectedRecord,
    selectedTranscript,
    t('meetings.selectRecordingMarkdown', { defaultValue: 'Select a recording in the panel to view the Markdown summary.' }),
  )
  const selectedTranscriptMarkdown = buildTranscriptMarkdown(
    selectedRecord,
    selectedTranscript,
    t('meetings.transcriptUnavailable'),
  )
  const selectedDetailMarkdown = selectedDetailTab === 'summary'
    ? selectedSummaryMarkdown
    : selectedTranscriptMarkdown

  return (
    <div className="h-full overflow-auto overflow-x-hidden bg-background px-4 py-5 sm:px-5">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5">
        <header className="grid min-w-0 gap-4 border-b border-border/50 pb-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:items-end">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-foreground/[0.025] px-2 py-1 text-xs text-muted-foreground">
                <Video className="size-3.5" />
                <span>{t('meetings.eyebrow')}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setHowItWorksOpen(true)}
              >
                <HelpCircle className="size-3.5" />
                {t('meetings.flowTitle')}
              </Button>
              <Button
                type="button"
                variant={activeSection === 'invite' ? 'secondary' : 'outline'}
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setActiveSection('invite')}
              >
                <Sparkles className="size-3.5" />
                {t('meetings.inviteSection')}
              </Button>
              <Button
                type="button"
                variant={activeSection === 'results' ? 'secondary' : 'outline'}
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => setActiveSection('results')}
              >
                <MessageSquareText className="size-3.5" />
                {t('meetings.resultsSection')}
              </Button>
            </div>
            <div className="space-y-1">
              <h1 className="text-[26px] font-semibold tracking-tight text-foreground">{t('meetings.title')}</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('meetings.subtitle')}</p>
            </div>
          </div>
          <div className="min-w-0 rounded-lg border border-border/65 bg-card/25 p-3 text-xs text-muted-foreground">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-foreground/85">
                  <CheckCircle2 className="size-4" />
                  <span className="font-medium">{t('meetings.apiReady')}</span>
                </div>
                <p className="mt-1 line-clamp-2">{t('meetings.authHint')}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-full shrink-0 gap-1.5 px-2.5 text-xs sm:w-auto"
                disabled={isAuthenticating}
                onClick={handleGoogleAuth}
              >
                {isAuthenticating ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
                {t('meetings.authGoogle')}
              </Button>
            </div>
          </div>
        </header>

        <Dialog open={howItWorksOpen} onOpenChange={setHowItWorksOpen}>
          <DialogContent className="sm:max-w-[760px]">
            <DialogHeader>
              <DialogTitle>{t('meetings.flowTitle')}</DialogTitle>
              <DialogDescription>{t('meetings.flowDescription')}</DialogDescription>
            </DialogHeader>
            <div className="grid min-w-0 gap-4 md:grid-cols-3">
              <ProcessStep
                icon={<Video className="size-3.5" />}
                title={t('meetings.flowOpenTitle')}
                description={t('meetings.flowOpenDescription')}
              />
              <ProcessStep
                icon={<MessageSquareText className="size-3.5" />}
                title={t('meetings.flowCaptureTitle')}
                description={t('meetings.flowCaptureDescription')}
              />
              <ProcessStep
                icon={<FileText className="size-3.5" />}
                title={t('meetings.flowNotesTitle')}
                description={t('meetings.flowNotesDescription')}
              />
            </div>
            <div className="rounded-lg border border-border/55 bg-background/35 p-3">
              <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
                <span>{t('meetings.privacyNote')}</span>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {activeSection === 'invite' ? (
          <form onSubmit={handleJoin} className="min-w-0 rounded-lg border border-border/70 bg-card/35 shadow-minimal">
            <div className="grid min-w-0 gap-0 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
              <section className="min-w-0 border-b border-border/60 p-4 sm:p-5 xl:border-b-0 xl:border-r">
                <div className="space-y-5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="meeting-link" className="text-sm font-medium text-foreground">
                        {t('meetings.inputLabel')}
                      </label>
                      <span className="hidden text-xs text-muted-foreground sm:inline">{t('meetings.inputHint')}</span>
                    </div>
                    <div className="grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <Input
                        id="meeting-link"
                        value={meetingInput}
                        onChange={(event) => setMeetingInput(event.target.value)}
                        placeholder={t('meetings.inputPlaceholder')}
                        autoFocus
                        className="h-11 flex-1 border-border/70 bg-background/70 text-sm shadow-none focus-visible:ring-foreground/15"
                      />
                      <Button type="submit" disabled={!canJoin} className="h-11 w-full shrink-0 gap-2 px-4 xl:w-auto">
                        {isJoining ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                        {t('meetings.join')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!workspaceId || !normalizedUrl || isJoining || isCraftRecording}
                        className="h-11 w-full shrink-0 gap-2 px-4 xl:w-auto"
                        onClick={handleCraftRecord}
                      >
                        {isCraftRecording ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
                        {t('meetings.craftRecordButton')}
                      </Button>
                    </div>
                    <p className="truncate text-xs text-muted-foreground/85">
                      {normalizedUrl ? normalizedUrl : t('meetings.authDescription')}
                    </p>
                  </div>

                  {detectedMeeting && (
                    <div className="rounded-lg border border-foreground/15 bg-foreground/[0.04] p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <Sparkles className="size-4" />
                            <span>{t('meetings.detectedTitle')}</span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{detectedMeeting.url}</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 px-2.5 text-xs"
                            onClick={handleDismissDetectedMeeting}
                            disabled={isJoining}
                          >
                            {t('meetings.detectedDismiss')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 gap-1.5 px-2.5 text-xs"
                            onClick={handleApproveDetectedMeeting}
                            disabled={isJoining}
                          >
                            {isJoining ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                            {t('meetings.detectedApprove')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="min-w-0 p-4 sm:p-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">{t('meetings.optionsTitle')}</h2>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t('meetings.optionsHint')}</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                            aria-label={t('meetings.configAriaLabel')}
                          >
                            <Settings className="size-3.5" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[320px] p-3">
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-medium text-foreground">{t('meetings.configTitle')}</div>
                                <div className="text-xs text-muted-foreground">
                                  {hasTranscriptionApiKey ? t('meetings.configApiKeySaved') : t('meetings.configApiKeyNotSet')}
                                </div>
                              </div>
                              {isLoadingTranscriptionSettings && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                            </div>
                            <label className="block space-y-1.5">
                              <span className="text-xs font-medium text-foreground">{t('meetings.configModel')}</span>
                              <Select
                                value={transcriptionProvider}
                                onValueChange={handleTranscriptionProviderChange}
                                disabled={isLoadingTranscriptionSettings || isSavingTranscriptionSettings}
                              >
                                <SelectTrigger className="h-9 bg-background/65 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="deepgram">Deepgram</SelectItem>
                                </SelectContent>
                              </Select>
                            </label>
                            <label className="block space-y-1.5">
                              <span className="text-xs font-medium text-foreground">{t('meetings.configModel')}</span>
                              <Select
                                value={transcriptionModel}
                                onValueChange={setTranscriptionModel}
                                disabled={isLoadingTranscriptionSettings || isSavingTranscriptionSettings}
                              >
                                <SelectTrigger className="h-9 bg-background/65 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {currentTranscriptionModels.map((model) => (
                                    <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </label>
                            <label className="block space-y-1.5">
                              <span className="text-xs font-medium text-foreground">{t('meetings.configApiKeyLabel')}</span>
                              <Input
                                type="password"
                                value={transcriptionApiKeyDraft}
                                onChange={(event) => setTranscriptionApiKeyDraft(event.target.value)}
                                placeholder={hasTranscriptionApiKey ? t('meetings.configApiKeyPlaceholderExists') : t('meetings.configApiKeyPlaceholderNew')}
                                disabled={isLoadingTranscriptionSettings || isSavingTranscriptionSettings}
                                className="h-9 bg-background/65 text-xs"
                              />
                            </label>
                            <Button
                              type="button"
                              size="sm"
                              className="h-8 w-full gap-1.5 text-xs"
                              disabled={isLoadingTranscriptionSettings || isSavingTranscriptionSettings}
                              onClick={handleSaveTranscriptionSettings}
                            >
                              {isSavingTranscriptionSettings ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                              {t('meetings.configSave')}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <MeetingOption
                      checked={transcriptionEnabled}
                      onChange={setTranscriptionEnabled}
                      icon={<MessageSquareText className="size-4" />}
                      title={t('meetings.transcription')}
                      description={t('meetings.transcriptionDescription')}
                    />
                    <MeetingOption
                      checked={summaryEnabled}
                      onChange={setSummaryEnabled}
                      icon={<Sparkles className="size-4" />}
                      title={t('meetings.summary')}
                      description={t('meetings.summaryDescription')}
                    />
                    <MeetingOption
                      checked={followUpEnabled}
                      onChange={setFollowUpEnabled}
                      icon={<ClipboardList className="size-4" />}
                      title={t('meetings.followUp')}
                      description={t('meetings.followUpDescription')}
                    />
                  </div>
                </div>
              </section>
            </div>
          </form>
        ) : selectedMeetingId ? (
          <section className="rounded-lg border border-border/70 bg-card/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium text-foreground">
                  {selectedRecord?.title || selectedRecord?.code || t('meetings.selectedMeetingTitle')}
                </h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {selectedRecord?.captureMode === 'craft' ? t('meetings.captureModeCraft') : t('meetings.captureModeHermes')}
                  {selectedRecord?.transcriptionProvider && selectedRecord.transcriptionModel
                    ? ` · ${getTranscriptionProviderLabel(selectedRecord.transcriptionProvider)} ${selectedRecord.transcriptionModel}`
                    : ''}
                </p>
              </div>
              {selectedRecord?.status && (
                <span className="shrink-0 rounded-md border border-border/65 bg-background/45 px-2 py-1 text-xs text-muted-foreground">
                  {selectedRecord.status}
                </span>
              )}
            </div>
            <ProcessingPipeline record={selectedRecord} transcript={selectedTranscript} t={t} />
            <div className="mb-3 flex flex-wrap gap-2">
              {([
                ['summary', t('meetings.summary')],
                ['transcript', t('meetings.transcription')],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setSelectedDetailTab(tab)}
                  className={cn(
                    'h-8 rounded-full border px-3 text-xs font-medium transition-colors',
                    selectedDetailTab === tab
                      ? 'border-foreground bg-foreground text-background shadow-sm'
                      : 'border-border/70 bg-background/55 text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="max-h-[520px] overflow-y-auto rounded-lg border border-border/55 bg-background/35 p-4">
              <Markdown mode="minimal" className="text-sm leading-6 text-foreground">
                {selectedDetailMarkdown}
              </Markdown>
            </div>
          </section>
        ) : (
          <section className="rounded-lg border border-border/70 bg-card/25 p-6">
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-10 text-center">
              <MessageSquareText className="size-8 text-muted-foreground" />
              <div className="space-y-1">
                <h2 className="text-sm font-medium text-foreground">{t('meetings.resultsEmptyTitle')}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{t('meetings.resultsEmptyDescription')}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setActiveSection('invite')}>
                {t('meetings.inviteSection')}
              </Button>
            </div>
          </section>
        )}

        {detectedMeeting && (
          <p className="sr-only">
            {t('meetings.detectedDescription')}
          </p>
        )}
      </div>
    </div>
  )
}

export default MeetingsPage
