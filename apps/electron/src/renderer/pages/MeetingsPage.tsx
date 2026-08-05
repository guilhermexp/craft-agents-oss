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
import { isMissingMeetingError, normalizeGoogleMeetInput, resolveEffectiveMeetingId } from '@/lib/meetings-selection'
import { isMeetingPostProcessingRunning, meetingStatusLabelKey } from '@/lib/meeting-status-label'
import { getRecordingMediaUrl } from '@/lib/meeting-recording-preview'
import { cn } from '@/lib/utils'
import { getFileManagerName } from '@/lib/platform'
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
        'group flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/15',
        checked
          ? 'border-foreground/15 bg-foreground/[0.045] text-foreground'
          : 'border-border/45 bg-transparent text-muted-foreground hover:border-border/70 hover:bg-foreground/[0.02]'
      )}
    >
      <span className={cn('text-muted-foreground transition-colors group-hover:text-foreground/75', checked && 'text-foreground')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium leading-5">{title}</span>
        <span className="sr-only">{description}</span>
      </span>
      <Switch className="scale-90" checked={checked} onCheckedChange={onChange} onClick={(event) => event.stopPropagation()} />
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
  t: (key: string) => string,
): string {
  if (transcript?.summaryMarkdown) return transcript.summaryMarkdown
  if (record?.summaryMarkdown) return record.summaryMarkdown
  if (!record) return emptyPlaceholder

  const origin = record.captureMode === 'craft' ? t('meetings.captureModeCraft') : t('meetings.captureModeHermes')
  const lines = [
    `# ${record.title || 'Google Meet'}`,
    '',
    `- ${t('meetings.summaryDocOrigin')}: ${origin}`,
    `- ${t('meetings.summaryDocStatus')}: ${t(meetingStatusLabelKey(record))}`,
    `- ${t('meetings.summaryDocLink')}: ${record.url}`,
  ]
  if (record.transcriptionProvider && record.transcriptionModel) {
    lines.push(`- ${t('meetings.docLabelTranscription')}: ${getTranscriptionProviderLabel(record.transcriptionProvider)} / ${record.transcriptionModel}`)
  }
  lines.push(
    '',
    `## ${t('meetings.docHeadingSummary')}`,
    '',
    transcript?.message || t('meetings.docSummaryPending'),
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
  t: (key: string) => string,
): string {
  if (!record) return unavailableText

  const lines = [
    `# ${record.title || record.code || 'Google Meet'}`,
    '',
    `- ${t('meetings.summaryDocLink')}: ${record.url}`,
    `- ${t('meetings.summaryDocStatus')}: ${t(meetingStatusLabelKey(record))}`,
    `- ${t('meetings.docLabelCapture')}: ${record.captureMode === 'craft' ? t('meetings.captureModeCraft') : t('meetings.captureModeHermes')}`,
  ]

  if (record.recording?.durationMs) {
    lines.push(`- ${t('meetings.docLabelDuration')}: ${formatTranscriptTimestamp(record.recording.durationMs)}`)
  }

  lines.push('', `## ${t('meetings.docHeadingTranscript')}`, '')

  if (!transcript || transcript.transcript.length === 0) {
    lines.push(transcript?.message || unavailableText)
    return lines.join('\n')
  }

  for (const segment of transcript.transcript) {
    const speaker = segment.speaker?.trim() || t('meetings.docSpeakerFallback')
    const timestamp = formatTranscriptTimestamp(segment.startedAt ?? segment.timestamp)
    lines.push(`**[${timestamp}] ${speaker}:** ${segment.text}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

export function MeetingsPage({ workspaceId, selectedMeetingId }: MeetingsPageProps) {
  const { t } = useTranslation()
  const fileManagerName = getFileManagerName()
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
  // Store the tab keyed to the meeting it was selected for, so it auto-resets
  // to 'summary' when the parent selects a different meeting — no effect needed.
  const [detailTabEntry, setDetailTabEntry] = useState<{ forMeetingId: string | null; tab: MeetingDetailTab }>({ forMeetingId: null, tab: 'summary' })
  const selectedDetailTab: MeetingDetailTab = detailTabEntry.forMeetingId === selectedMeetingId ? detailTabEntry.tab : 'summary'
  const setSelectedDetailTab = (tab: MeetingDetailTab) => setDetailTabEntry({ forMeetingId: selectedMeetingId ?? null, tab })
  const [activeSection, setActiveSection] = useState<MeetingsSection>('invite')
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [detectedMeeting, setDetectedMeeting] = useState<{ url: string; instanceId: string; profileId?: string; title?: string } | null>(null)
  const promptedMeetUrlsRef = React.useRef<Set<string>>(null!)
  promptedMeetUrlsRef.current ??= new Set()
  const launchedMeetUrlsRef = React.useRef<Set<string>>(null!)
  launchedMeetUrlsRef.current ??= new Set()
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
  }, [workspaceId, t])

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
    let timer: number | undefined
    let latestRecord: MeetingRecord | null = null
    let latestTranscript: MeetingTranscriptResult | null = null
    const loadSelectedMeeting = async () => {
      try {
        const [record, transcript] = await Promise.all([
          window.electronAPI.meetings.status(workspaceId, effectiveMeetingId),
          window.electronAPI.meetings.transcript(workspaceId, effectiveMeetingId),
        ])
        if (cancelled) return
        latestRecord = record
        latestTranscript = transcript
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

    // Poll fast (1.5s) while live or while the post-recording pipeline still
    // works; back off to 15s only once the record, its phase and the transcript
    // are all resolved — nothing else lands after that.
    const schedule = () => {
      if (cancelled) return
      const settled =
        latestRecord != null
        && (latestRecord.status === 'stopped' || latestRecord.status === 'error')
        && !isMeetingPostProcessingRunning(latestRecord)
        && (latestTranscript?.status === 'ready' || latestTranscript?.status === 'unavailable')
      timer = window.setTimeout(async () => {
        await loadSelectedMeeting()
        schedule()
      }, settled ? 15_000 : 1_500)
    }

    void loadSelectedMeeting()
    const handleChanged = () => { void loadSelectedMeeting() }
    window.addEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
    schedule()
    return () => {
      cancelled = true
      window.removeEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
      if (timer !== undefined) window.clearTimeout(timer)
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
      // record, and switch to the results view without waiting for a list click.
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
    t,
  )
  const selectedTranscriptMarkdown = buildTranscriptMarkdown(
    selectedRecord,
    selectedTranscript,
    t('meetings.transcriptUnavailable'),
    t,
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
          <header className="mx-auto w-full max-w-3xl pt-4 sm:pt-8">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/45 bg-foreground/[0.025] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <Video className="size-3" />
                <span>{t('meetings.eyebrow')}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                    activeSection === 'results' ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setActiveSection(activeSection === 'results' ? 'invite' : 'results')}
                >
                  <MessageSquareText className="size-3.5" />
                  {t('meetings.resultsSection')}
                </button>
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                  onClick={() => setHowItWorksOpen(true)}
                  aria-label={t('meetings.flowTitle')}
                >
                  <HelpCircle className="size-4" />
                </button>
              </div>
            </div>

            <div className="mt-8 space-y-3">
              <h1 className="text-[34px] font-semibold tracking-[-0.04em] text-foreground sm:text-[42px]">
                {t('meetings.title')}
              </h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                {t('meetings.subtitle')}
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-foreground/65" />
                {t('meetings.apiReady')}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                disabled={isAuthenticating}
                onClick={handleGoogleAuth}
              >
                {isAuthenticating ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
                {t('meetings.authGoogle')}
              </button>
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
          <form onSubmit={handleJoin} className="mx-auto w-full max-w-3xl min-w-0 space-y-4">
            <div className="rounded-2xl border border-border/55 bg-card/[0.18] p-2 shadow-minimal backdrop-blur-sm">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="meeting-link"
                  value={meetingInput}
                  onChange={(event) => setMeetingInput(event.target.value)}
                  placeholder={t('meetings.inputPlaceholder')}
                  aria-label={t('meetings.inputLabel')}
                  autoFocus
                  className="h-12 flex-1 border-0 bg-transparent px-3 text-base shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0"
                />
                <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                  <Button type="submit" disabled={!canJoin} className="h-10 gap-2 px-4 sm:h-11">
                    {isJoining ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                    {t('meetings.join')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!workspaceId || !normalizedUrl || isJoining || isCraftRecording}
                    className="h-10 gap-2 border-border/55 bg-background/30 px-4 sm:h-11"
                    onClick={handleCraftRecord}
                  >
                    {isCraftRecording ? <Loader2 className="size-4 animate-spin" /> : <Video className="size-4" />}
                    {t('meetings.craftRecordButton')}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 truncate text-xs text-muted-foreground/75">
                {normalizedUrl ? normalizedUrl : t('meetings.authDescription')}
              </p>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-fit shrink-0 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                    aria-label={t('meetings.configAriaLabel')}
                  >
                    <Settings className="size-3.5" />
                    {t('meetings.optionsTitle')}
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
                      <span className="text-xs font-medium text-foreground">{t('meetings.configProvider')}</span>
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

            <div className="grid gap-2 sm:grid-cols-3">
              <MeetingOption
                checked={transcriptionEnabled}
                onChange={setTranscriptionEnabled}
                icon={<MessageSquareText className="size-3.5" />}
                title={t('meetings.transcription')}
                description={t('meetings.transcriptionDescription')}
              />
              <MeetingOption
                checked={summaryEnabled}
                onChange={setSummaryEnabled}
                icon={<Sparkles className="size-3.5" />}
                title={t('meetings.summary')}
                description={t('meetings.summaryDescription')}
              />
              <MeetingOption
                checked={followUpEnabled}
                onChange={setFollowUpEnabled}
                icon={<ClipboardList className="size-3.5" />}
                title={t('meetings.followUp')}
                description={t('meetings.followUpDescription')}
              />
            </div>

            {detectedMeeting && (
              <div className="rounded-xl border border-border/55 bg-foreground/[0.025] p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                      <Sparkles className="size-3.5" />
                      <span>{t('meetings.detectedTitle')}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{detectedMeeting.url}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
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
                    {t('meetings.recordingPreview')}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {selectedRecord?.recording?.durationMs
                      ? formatTranscriptTimestamp(selectedRecord.recording.durationMs)
                      : selectedRecord ? t(meetingStatusLabelKey(selectedRecord)) : ''}
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
                    {t('chat.viewInFileManager', { fileManager: fileManagerName })}
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
                    onLoadedMetadata={(event) => {
                      // Webm cru do MediaRecorder não tem Duration/Cues: o
                      // Chromium reporta duração infinita e o seek morre. O
                      // remux no seal corrige os arquivos novos; para os
                      // antigos, saltar para o fim força o player a calcular a
                      // duração real e liberar o seek.
                      const video = event.currentTarget
                      if (video.duration !== Infinity) return
                      const restore = () => {
                        if (video.duration === Infinity) return
                        video.removeEventListener('durationchange', restore)
                        video.currentTime = 0
                      }
                      video.addEventListener('durationchange', restore)
                      video.currentTime = 1e10
                    }}
                    aria-label={t('meetings.recordingPreview')}
                    className="size-full bg-black object-contain"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center p-4 text-center text-xs leading-5 text-muted-foreground">
                    {t('meetings.recordingPreviewUnavailable')}
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

