import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
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
import { Markdown } from '@/components/markdown'
import { MEETINGS_CHANGED_EVENT } from '@/components/app-shell/MeetingsListPanel'
import { cn } from '@/lib/utils'
import type { BrowserInstanceInfo, MeetingRecord, MeetingStartInput, MeetingTranscriptResult } from '../../shared/types'

const GOOGLE_MEET_PREFIX = 'https://meet.google.com/'

type MeetingTranscriptionProvider = NonNullable<MeetingStartInput['transcriptionProvider']>

interface TranscriptionModelOption {
  id: string
  label: string
}

const TRANSCRIPTION_MODELS: Record<MeetingTranscriptionProvider, TranscriptionModelOption[]> = {
  deepgram: [
    { id: 'nova-3', label: 'Nova 3' },
    { id: 'nova-2', label: 'Nova 2' },
  ],
  groq: [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3' },
  ],
}

function getTranscriptionProviderLabel(provider: MeetingTranscriptionProvider): string {
  return provider === 'groq' ? 'Groq' : 'Deepgram'
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

  const origin = record.captureMode === 'craft' ? 'Craft interno' : 'Hermes'
  const status = record.status === 'running' ? 'em andamento' : record.status
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
    transcript?.message || 'Resumo ainda nao disponivel para esta gravacao.',
  )
  return lines.join('\n')
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
  const [detectedMeeting, setDetectedMeeting] = useState<{ url: string; instanceId: string; profileId?: string; title?: string } | null>(null)
  const promptedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const launchedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const normalizedUrl = useMemo(() => normalizeGoogleMeetInput(meetingInput), [meetingInput])
  const canJoin = !!workspaceId && !!normalizedUrl && !isJoining
  const currentTranscriptionModels = TRANSCRIPTION_MODELS[transcriptionProvider]

  const handleTranscriptionProviderChange = (value: string) => {
    const provider: MeetingTranscriptionProvider = value === 'groq' ? 'groq' : 'deepgram'
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
        const message = error instanceof Error ? error.message : 'Nao foi possivel carregar a configuracao de transcricao.'
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
      toast.error('Workspace ativo nao encontrado para salvar a configuracao.')
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
      toast.success('Configuracao de transcricao salva.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nao foi possivel salvar a configuracao de transcricao.'
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
    const timer = window.setInterval(() => {
      void loadSelectedMeeting()
    }, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
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
        throw new Error('Workspace ativo nao encontrado para salvar a gravacao.')
      }

      const result: MeetingRecord = await meetingsApi.start(workspaceId, request)
      if (result.status === 'error') throw new Error(result.error || t('meetings.joinError'))
      launchedMeetUrlsRef.current.add(meetingUrl)
      setDetectedMeeting((current) => current?.url === meetingUrl ? null : current)
      window.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT))
      toast.success(request.captureMode === 'craft' ? 'Gravacao interna iniciada no Craft.' : t('meetings.agentInvited'))
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

  return (
    <div className="h-full overflow-auto overflow-x-hidden bg-background px-4 py-5 sm:px-5">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5">
        <header className="grid min-w-0 gap-4 border-b border-border/50 pb-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:items-end">
          <div className="min-w-0 space-y-3">
            <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-foreground/[0.025] px-2 py-1 text-xs text-muted-foreground">
              <Video className="size-3.5" />
              <span>{t('meetings.eyebrow')}</span>
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
                      Gravar no Craft
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
                          aria-label="Configurar transcricao"
                        >
                          <Settings className="size-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-[320px] p-3">
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-foreground">Transcricao</div>
                              <div className="text-xs text-muted-foreground">
                                {hasTranscriptionApiKey ? 'API key salva' : 'API key nao configurada'}
                              </div>
                            </div>
                            {isLoadingTranscriptionSettings && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                          </div>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-foreground">Motor</span>
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
                                <SelectItem value="groq">Groq</SelectItem>
                              </SelectContent>
                            </Select>
                          </label>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-foreground">Modelo</span>
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
                            <span className="text-xs font-medium text-foreground">API key</span>
                            <Input
                              type="password"
                              value={transcriptionApiKeyDraft}
                              onChange={(event) => setTranscriptionApiKeyDraft(event.target.value)}
                              placeholder={hasTranscriptionApiKey ? 'Chave ja salva' : 'Cole a chave do motor'}
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
                            Salvar
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

        {selectedMeetingId && (
          <section className="rounded-lg border border-border/70 bg-card/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium text-foreground">
                  {selectedRecord?.title || selectedRecord?.code || 'Resumo da reunião'}
                </h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {selectedRecord?.captureMode === 'craft' ? 'Gravacao interna do Craft' : 'Registro Hermes'}
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
            <div className="max-h-[360px] overflow-y-auto rounded-lg border border-border/55 bg-background/35 p-3">
              <Markdown mode="minimal" className="text-sm leading-6 text-foreground">
                {selectedSummaryMarkdown}
              </Markdown>
            </div>
          </section>
        )}

        <section className="grid min-w-0 gap-4 rounded-lg border border-border/55 bg-card/20 p-4 2xl:grid-cols-[220px_minmax(0,1fr)_280px] 2xl:items-start">
          <div>
            <h2 className="text-sm font-medium text-foreground">{t('meetings.flowTitle')}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('meetings.flowDescription')}</p>
          </div>
          <div className="grid min-w-0 gap-4 xl:grid-cols-3">
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
        </section>

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
