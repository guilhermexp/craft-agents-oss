import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  HelpCircle,
  Loader2,
  MessageSquareText,
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
import { isMissingMeetingError, resolveEffectiveMeetingId } from '@/lib/meetings-selection'
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

function getRecordingMediaUrl(record: MeetingRecord | null): string | null {
  const recordingPath = record?.recording?.path
  if (!recordingPath) return null
  return `media://recording/${encodeURIComponent(recordingPath)}`
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
  // Locally-started meeting id — drives live status/feedback before the parent
  // selects it (the parent's selectedMeetingId only updates from the list panel).
  const [liveStartedId, setLiveStartedId] = useState<string | null>(null)
  const [selectedRecord, setSelectedRecord] = useState<MeetingRecord | null>(null)
  const [selectedTranscript, setSelectedTranscript] = useState<MeetingTranscriptResult | null>(null)
  const [missingMeetingId, setMissingMeetingId] = useState<string | null>(null)
  const [selectedDetailTab, setSelectedDetailTab] = useState<MeetingDetailTab>('summary')
  const [activeSection, setActiveSection] = useState<MeetingsSection>('invite')
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [detectedMeeting, setDetectedMeeting] = useState<{ url: string; instanceId: string; profileId?: string; title?: string } | null>(null)
  const promptedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const launchedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const normalizedUrl = useMemo(() => normalizeGoogleMeetInput(meetingInput), [meetingInput])
  // Prefer the parent's explicit selection; fall back to a just-started meeting
  // so recording/transcription feedback shows immediately after clicking record.
  const effectiveMeetingId = resolveEffectiveMeetingId({ selectedMeetingId, liveStartedId, missingMeetingId })
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
    if (selectedMeetingId) {
      // Parent made an explicit selection — drop any local just-started override.
      setLiveStartedId(null)
      setActiveSection('results')
    }
  }, [selectedMeetingId])

  React.useEffect(() => {
    if (!workspaceId || !effectiveMeetingId) {
      setSelectedRecord(null)
      setSelectedTranscript(null)
      return
    }

    let cancelled = false
    const loadSelectedMeeting = async () => {
      try {
        const [record, transcript] = await Promise.all([
          window.electronAPI.meetings.status(workspaceId, effectiveMeetingId),
          window.electronAPI.meetings.transcript(workspaceId, effectiveMeetingId),
        ])
        if (cancelled) return
        setSelectedRecord(record)
        setSelectedTranscript(transcript)
      } catch (error) {
        if (cancelled) return
        if (isMissingMeetingError(error)) {
          setMissingMeetingId(effectiveMeetingId)
          setLiveStartedId((current) => current === effectiveMeetingId ? null : current)
          setSelectedRecord(null)
          setSelectedTranscript(null)
          return
        }
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
  }, [effectiveMeetingId, t, workspaceId])

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
      setMissingMeetingId(null)
      // Surface the live recording immediately: select it locally, show its
      // record, and switch to the results view so the ProcessingPipeline renders
      // (recording → transcription feedback) without waiting for a list click.
      setLiveStartedId(result.id)
      setSelectedRecord(result)
      setSelectedTranscript(null)
      setActiveSection('results')
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
  const isShowingResult = activeSection === 'results' && Boolean(effectiveMeetingId)
  const recordingMediaUrl = getRecordingMediaUrl(selectedRecord)

  return (
    <div className={cn(
      'h-full overflow-auto overflow-x-hidden bg-background px-4 py-5 sm:px-5',
      isShowingResult && 'py-4'
    )}>
      <div className={cn(
        'mx-auto flex w-full min-w-0 flex-col gap-5',
        isShowingResult ? 'max-w-7xl' : 'max-w-5xl'
      )}>
        {!isShowingResult && (
        <header className="grid min-w-0 gap-4 border-b border-border/50 pb-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:items-end">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-foreground/[0.025] px-2 py-1 text-xs text-muted-foreground">
                <Video className="size-3.5" />
                <span>{t('meetings.eyebrow')}</span>
              </div>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setHowItWorksOpen(true)}
              >
                <HelpCircle className="size-3.5" />
                {t('meetings.flowTitle')}
              </button>
            </div>
            <div className="space-y-1">
              <h1 className="text-[26px] font-semibold tracking-tight text-foreground">{t('meetings.title')}</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('meetings.subtitle')}</p>
            </div>
            <div className="inline-flex items-center rounded-lg border border-border/70 bg-foreground/[0.02] p-0.5">
              {([
                ['invite', <Sparkles key="i" className="size-3.5" />, t('meetings.inviteSection')],
                ['results', <MessageSquareText key="r" className="size-3.5" />, t('meetings.resultsSection')],
              ] as const).map(([section, icon, label]) => (
                <button
                  key={section}
                  type="button"
                  onClick={() => setActiveSection(section)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
                    activeSection === section
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
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
        )}

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
                        {isCraftRecording ? <Loader2 className="size-4 animate-spin" /> : <Video className="size-4" />}
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
        ) : effectiveMeetingId ? (
          <section className="grid min-h-[calc(100vh-7rem)] min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,430px)]">
            <div className="min-w-0 overflow-hidden rounded-lg border border-border/65 bg-card/20">
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/55 px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {([
                    ['summary', t('meetings.summary')],
                    ['transcript', t('meetings.transcription')],
                  ] as const).map(([tab, label]) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setSelectedDetailTab(tab)}
                      className={cn(
                        'h-8 rounded-md border px-3 text-xs font-medium transition-colors',
                        selectedDetailTab === tab
                          ? 'border-foreground bg-foreground text-background shadow-xs'
                          : 'border-border/70 bg-background/35 text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                  {selectedRecord?.title || selectedRecord?.code || t('meetings.selectedMeetingTitle')}
                </span>
              </div>
              <div className="max-h-[calc(100vh-12rem)] overflow-y-auto px-5 py-5">
                <Markdown mode="minimal" className="text-sm leading-7 text-foreground">
                  {selectedDetailMarkdown}
                </Markdown>
              </div>
            </div>

            <aside className="min-w-0 rounded-lg border border-border/65 bg-card/20 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {t('meetings.recordingPreview', { defaultValue: 'Gravação' })}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {selectedRecord?.recording?.durationMs
                      ? formatTranscriptTimestamp(selectedRecord.recording.durationMs)
                      : selectedRecord?.status ?? ''}
                  </div>
                </div>
                {selectedRecord?.recording?.path && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
                    onClick={() => window.electronAPI.showInFolder(selectedRecord.recording!.path)}
                  >
                    <ExternalLink className="size-3.5" />
                    {t('chat.viewInFileManager', { fileManager: 'Finder' })}
                  </Button>
                )}
              </div>
              <div className="aspect-video overflow-hidden rounded-md border border-border/60 bg-black">
                {recordingMediaUrl ? (
                  <video
                    key={recordingMediaUrl}
                    src={recordingMediaUrl}
                    controls
                    preload="metadata"
                    className="size-full bg-black object-contain"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center p-4 text-center text-xs leading-5 text-muted-foreground">
                    {t('meetings.recordingPreviewUnavailable', { defaultValue: 'A gravação em vídeo aparecerá aqui quando o arquivo WebM estiver salvo.' })}
                  </div>
                )}
              </div>
            </aside>
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
