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
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { BrowserInstanceInfo, MeetingRecord, MeetingStartInput } from '../../shared/types'

const GOOGLE_MEET_PREFIX = 'https://meet.google.com/'

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
    return null
  }
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
        'group flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/15',
        checked
          ? 'border-foreground/15 bg-foreground/[0.055] text-foreground'
          : 'border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-foreground/[0.035]'
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
          checked
            ? 'border-foreground/15 bg-background/80 text-foreground'
            : 'border-border/60 bg-background/40 text-muted-foreground group-hover:text-foreground/80'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}

function ProcessStep({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}

export function MeetingsPage() {
  const { t } = useTranslation()
  const [meetingInput, setMeetingInput] = useState('')
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(true)
  const [summaryEnabled, setSummaryEnabled] = useState(true)
  const [followUpEnabled, setFollowUpEnabled] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [detectedMeeting, setDetectedMeeting] = useState<{ url: string; instanceId: string; title?: string } | null>(null)
  const promptedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const launchedMeetUrlsRef = React.useRef<Set<string>>(new Set())
  const normalizedUrl = useMemo(() => normalizeGoogleMeetInput(meetingInput), [meetingInput])
  const canJoin = !!normalizedUrl && !isJoining

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

  const startHermesForMeet = React.useCallback(async (meetingUrl: string) => {
    const request: MeetingStartInput = {
      urlOrCode: meetingUrl,
      title: 'Google Meet',
      transcribe: transcriptionEnabled,
      summarizeOnEnd: summaryEnabled,
      followUpOnEnd: followUpEnabled,
    }

    setIsJoining(true)
    try {
      const meetingsApi = window.electronAPI.meetings
      if (meetingsApi?.start) {
        const result: MeetingRecord = await meetingsApi.start(request)
        if (result.status === 'error') throw new Error(result.error || t('meetings.joinError'))
        launchedMeetUrlsRef.current.add(meetingUrl)
        setDetectedMeeting((current) => current?.url === meetingUrl ? null : current)
        toast.success(t('meetings.agentInvited'))
        return
      }

      if (window.electronAPI.browserPane?.create) {
        await window.electronAPI.browserPane.create({ show: true, url: meetingUrl })
        launchedMeetUrlsRef.current.add(meetingUrl)
        setDetectedMeeting((current) => current?.url === meetingUrl ? null : current)
        toast.success(t('meetings.openedInBrowser'))
        return
      }

      await window.electronAPI.openUrl(meetingUrl)
      launchedMeetUrlsRef.current.add(meetingUrl)
      setDetectedMeeting((current) => current?.url === meetingUrl ? null : current)
      toast.success(t('meetings.openedInBrowser'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('meetings.joinError')
      toast.error(message)
    } finally {
      setIsJoining(false)
    }
  }, [followUpEnabled, summaryEnabled, t, transcriptionEnabled])

  React.useEffect(() => {
    const unsubscribe = window.electronAPI.browserPane?.onStateChanged?.((info: BrowserInstanceInfo) => {
      const meetingUrl = extractGoogleMeetMeetingUrl(info.url)
      if (!meetingUrl) return
      if (launchedMeetUrlsRef.current.has(meetingUrl)) return
      if (promptedMeetUrlsRef.current.has(meetingUrl)) return

      promptedMeetUrlsRef.current.add(meetingUrl)
      setMeetingInput(meetingUrl)
      setDetectedMeeting({ url: meetingUrl, instanceId: info.id, title: info.title })
      toast.info(t('meetings.detectedToast'))
    })

    return () => unsubscribe?.()
  }, [t])

  const handleApproveDetectedMeeting = async () => {
    if (!detectedMeeting) return
    await startHermesForMeet(detectedMeeting.url)
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

  return (
    <div className="h-full overflow-auto bg-background px-6 py-7">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-foreground/[0.035] px-2.5 py-1 text-xs text-muted-foreground">
              <Video className="h-3.5 w-3.5" />
              <span>{t('meetings.eyebrow')}</span>
            </div>
            <div className="space-y-1">
              <h1 className="text-[28px] font-semibold tracking-tight text-foreground">{t('meetings.title')}</h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">{t('meetings.subtitle')}</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-3 text-xs text-muted-foreground md:min-w-[270px]">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-foreground/70" />
              <span>{t('meetings.apiReady')}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
              <span>{t('meetings.authHint')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
                disabled={isAuthenticating}
                onClick={handleGoogleAuth}
              >
                {isAuthenticating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                {t('meetings.authGoogle')}
              </Button>
            </div>
            <p className="leading-5 text-muted-foreground/90">{t('meetings.authDescription')}</p>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <form onSubmit={handleJoin} className="rounded-2xl border border-border/70 bg-card/45 p-5 shadow-minimal backdrop-blur-sm">
            <div className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="meeting-link" className="text-sm font-medium text-foreground">
                  {t('meetings.inputLabel')}
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="meeting-link"
                    value={meetingInput}
                    onChange={(event) => setMeetingInput(event.target.value)}
                    placeholder={t('meetings.inputPlaceholder')}
                    autoFocus
                    className="h-11 flex-1 border-border/70 bg-background/70 text-sm shadow-none focus-visible:ring-foreground/10"
                  />
                  <Button type="submit" disabled={!canJoin} className="h-11 shrink-0 gap-2 px-4">
                    {isJoining ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    {t('meetings.join')}
                  </Button>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {normalizedUrl ? normalizedUrl : t('meetings.inputHint')}
                </p>
              </div>

              {detectedMeeting && (
                <div className="rounded-xl border border-foreground/15 bg-foreground/[0.045] p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Sparkles className="h-4 w-4" />
                        <span>{t('meetings.detectedTitle')}</span>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">{t('meetings.detectedDescription')}</p>
                      <p className="truncate rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-xs text-muted-foreground">
                        {detectedMeeting.url}
                      </p>
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
                        {isJoining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                        {t('meetings.detectedApprove')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-foreground">{t('meetings.optionsTitle')}</h2>
                  <span className="text-xs text-muted-foreground">{t('meetings.optionsHint')}</span>
                </div>
                <div className="grid gap-2">
                  <MeetingOption
                    checked={transcriptionEnabled}
                    onChange={setTranscriptionEnabled}
                    icon={<MessageSquareText className="h-4 w-4" />}
                    title={t('meetings.transcription')}
                    description={t('meetings.transcriptionDescription')}
                  />
                  <MeetingOption
                    checked={summaryEnabled}
                    onChange={setSummaryEnabled}
                    icon={<Sparkles className="h-4 w-4" />}
                    title={t('meetings.summary')}
                    description={t('meetings.summaryDescription')}
                  />
                  <MeetingOption
                    checked={followUpEnabled}
                    onChange={setFollowUpEnabled}
                    icon={<ClipboardList className="h-4 w-4" />}
                    title={t('meetings.followUp')}
                    description={t('meetings.followUpDescription')}
                  />
                </div>
              </div>
            </div>
          </form>

          <aside className="rounded-2xl border border-border/70 bg-card/30 p-4 shadow-minimal">
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-foreground">{t('meetings.flowTitle')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('meetings.flowDescription')}</p>
              </div>
              <div className="space-y-4">
                <ProcessStep
                  icon={<Video className="h-3.5 w-3.5" />}
                  title={t('meetings.flowOpenTitle')}
                  description={t('meetings.flowOpenDescription')}
                />
                <ProcessStep
                  icon={<MessageSquareText className="h-3.5 w-3.5" />}
                  title={t('meetings.flowCaptureTitle')}
                  description={t('meetings.flowCaptureDescription')}
                />
                <ProcessStep
                  icon={<FileText className="h-3.5 w-3.5" />}
                  title={t('meetings.flowNotesTitle')}
                  description={t('meetings.flowNotesDescription')}
                />
              </div>
              <div className="rounded-xl border border-border/60 bg-background/45 p-3">
                <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
                  <span>{t('meetings.privacyNote')}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default MeetingsPage
