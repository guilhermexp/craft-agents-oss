/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { initReactI18next, useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { EyeOff, Monitor, PanelRight, PanelsTopLeft, Sparkles, Square, Video, X, XCircle } from 'lucide-react'
import { BrowserControls } from '@craft-agent/ui'
import { setupI18n } from '@craft-agent/shared/i18n'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { extractGoogleMeetMeetingUrl, shouldFinalizeOnMeetNavigation } from '@/lib/meet-navigation-finalize'
import { formatRecordingElapsed } from '@/lib/recording-elapsed'
import './index.css'

// Initialize i18n before any React rendering — this entry runs in its own
// renderer (BrowserView) and does not share state with the main app shell.
setupI18n([LanguageDetector, initReactI18next])

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolbarProfile {
  id: string
  name: string
  color: string
  kind?: 'personal' | 'client' | 'bot' | 'test'
  clientName?: string
}

interface ToolbarState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  profile?: ToolbarProfile | null
  availableProfiles?: ToolbarProfile[]
  /** True when a session is bound to this browser and can be tiled beside it. */
  hasBoundSession?: boolean
  /** Where the browser is presented right now: own window, or docked as a card. */
  displayMode?: 'floating' | 'integrated'
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      requestProfileManagement: () => Promise<void>
      switchProfile: (profileId: string) => Promise<string | null>
      toggleSessionPanel: () => Promise<boolean>
      requestDisplayMode: (mode: 'floating' | 'integrated') => Promise<boolean>
      inviteHermesToMeet: (payload: { urlOrCode: string; profileId?: string }) => Promise<{ status?: string; error?: string }>
      prepareRecording: (payload: { urlOrCode: string; workspaceId?: string; mimeType: string }) => Promise<{ recordingId: string; meetingId?: string; outputPath: string }>
      appendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<void>
      finalizeRecording: (recordingId: string, mimeType: string) => Promise<{ outputPath: string }>
      abortRecording: (recordingId: string) => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
    }
  }
}

interface ActiveToolbarRecording {
  id: string
  recorder: MediaRecorder
  /** Streams de origem (display + mic quando houver): são elas que param. */
  sourceStreams: MediaStream[]
  /** Contexto do mix, quando houve mais de uma faixa de áudio. */
  audioContext: AudioContext | null
  mimeType: string
  pendingChunks: Set<Promise<void>>
}

/**
 * Libera as fontes de captura. Parar a faixa mixada não bastaria: ela é um
 * destino de `AudioContext`, e as faixas de display/mic continuariam vivas —
 * o Meet seguiria mostrando o indicador de compartilhamento e o mic aberto.
 */
function stopCaptureSources(active: Pick<ActiveToolbarRecording, 'sourceStreams' | 'audioContext'>): void {
  active.sourceStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => { track.stop() })
  })
  if (active.audioContext && active.audioContext.state !== 'closed') {
    void active.audioContext.close().catch(() => { /* teardown best-effort */ })
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [inviteState, setInviteState] = useState<'idle' | 'starting' | 'sent' | 'error'>('idle')
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [recordingState, setRecordingState] = useState<'idle' | 'preparing' | 'recording' | 'stopping' | 'error'>('idle')
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const [activeRecordingMeetUrl, setActiveRecordingMeetUrl] = useState<string | null>(null)
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null)
  const [recordingNow, setRecordingNow] = useState<number>(() => Date.now())
  const recordingRef = useRef<ActiveToolbarRecording | null>(null)
  const menuContentRef = useRef<HTMLDivElement | null>(null)
  const profileMenuContentRef = useRef<HTMLDivElement | null>(null)
  const anyMenuOpen = windowMenuOpen || profileMenuOpen

  const api = window.browserToolbar
  const detectedMeetUrl = extractGoogleMeetMeetingUrl(state.url) ?? extractGoogleMeetMeetingUrl(state.title)
  const recordingMeetUrl = detectedMeetUrl ?? activeRecordingMeetUrl
  const recordingActive = recordingState === 'preparing' || recordingState === 'recording' || recordingState === 'stopping'
  const dockLabel = state.displayMode === 'integrated'
    ? t('browser.showAsSeparateWindow', { defaultValue: 'Show as Separate Window' })
    : t('browser.showInsideApp', { defaultValue: 'Show Inside App' })

  // Um único intervalo, vivo somente enquanto grava: o timer é indicador, a
  // duração autoritativa sai de `RecordingService.finalize`.
  useEffect(() => {
    if (recordingState !== 'recording' || recordingStartedAt === null) return
    setRecordingNow(Date.now())
    const timer = setInterval(() => { setRecordingNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [recordingState, recordingStartedAt])

  useEffect(() => {
    setInviteState('idle')
    setInviteError(null)
    if (detectedMeetUrl) {
      console.info('[browser-toolbar] detected Google Meet URL', {
        instanceId: api?.instanceId,
        detectedMeetUrl,
        rawUrl: state.url,
      })
    }
  }, [api?.instanceId, detectedMeetUrl, state.url])

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
      setProfileMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!anyMenuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, 120)

    const activeRef = windowMenuOpen ? menuContentRef : profileMenuContentRef
    const sendGeometry = () => {
      const height = Math.ceil(activeRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    let frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(() => {
      sendGeometry()
    })

    if (activeRef.current) {
      observer.observe(activeRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, anyMenuOpen, windowMenuOpen])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleInviteHermes = useCallback(async () => {
    if (!api || !detectedMeetUrl || inviteState === 'starting' || inviteState === 'sent') return
    setInviteState('starting')
    setInviteError(null)
    console.info('[browser-toolbar] invite Hermes handler start', {
      instanceId: api.instanceId,
      detectedMeetUrl,
      profileId: state.profile?.id,
    })

    try {
      const result = await api.inviteHermesToMeet({
        urlOrCode: detectedMeetUrl,
        profileId: state.profile?.id,
      })
      if (result?.status === 'error') throw new Error(result.error || 'Hermes failed to join')
      setInviteState('sent')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[browser-toolbar] invite Hermes failed', {
        instanceId: api.instanceId,
        detectedMeetUrl,
        error: message,
      })
      setInviteError(message)
      setInviteState('error')
    }
  }, [api, detectedMeetUrl, inviteState, state.profile?.id])

  const stopRecording = useCallback(async (mode: 'finalize' | 'abort') => {
    const active = recordingRef.current
    if (!active) return
    recordingRef.current = null
    setRecordingState('stopping')
    try {
      if (active.recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          active.recorder.onstop = () => resolve()
          active.recorder.stop()
        })
      }
      while (active.pendingChunks.size > 0) {
        await Promise.allSettled(Array.from(active.pendingChunks))
      }
      stopCaptureSources(active)
      if (mode === 'finalize') {
        const result = await api?.finalizeRecording(active.id, active.mimeType)
        console.info('[browser-toolbar] recording finalized', { recordingId: active.id, outputPath: result?.outputPath })
      } else {
        await api?.abortRecording(active.id)
      }
    } catch (error) {
      console.error('[browser-toolbar] stop recording failed', error)
    } finally {
      setRecordingState('idle')
      setRecordingError(null)
      setActiveRecordingMeetUrl(null)
      setRecordingStartedAt(null)
    }
  }, [api])

  // Navegar o pane NÃO encerra as faixas capturadas (medido em Electron 43): sem
  // este sinal a gravação seguiria ativa, gravando a página nova dentro do mesmo
  // arquivo. O `track.ended` abaixo cobre só "Stop sharing" e o teardown do frame.
  useEffect(() => {
    if (recordingState !== 'recording') return
    if (!shouldFinalizeOnMeetNavigation(activeRecordingMeetUrl, state.url)) return
    console.info('[browser-toolbar] pane left the meeting, auto-finalizing', {
      activeRecordingMeetUrl,
      currentUrl: state.url,
    })
    void stopRecording('finalize')
  }, [activeRecordingMeetUrl, recordingState, state.url, stopRecording])

  const handleToggleRecording = useCallback(async () => {
    if (recordingState === 'recording') {
      void stopRecording('finalize')
      return
    }
    if (!api || !detectedMeetUrl) return
    if (recordingState !== 'idle' && recordingState !== 'error') return

    setRecordingState('preparing')
    setRecordingError(null)
    setActiveRecordingMeetUrl(detectedMeetUrl)
    let prepared: { recordingId: string; outputPath: string } | null = null
    const sourceStreams: MediaStream[] = []
    let audioContext: AudioContext | null = null
    try {
      // O mime é escolhido antes do prepare porque o main precisa dele para
      // selar a gravação no quit, quando este renderer já não existe.
      const mimeTypeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      const mimeType = mimeTypeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? mimeTypeCandidates[mimeTypeCandidates.length - 1]!
      prepared = await api.prepareRecording({ urlOrCode: detectedMeetUrl, mimeType })
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })
      sourceStreams.push(displayStream)
      const videoTrack = displayStream.getVideoTracks()[0]
      if (!videoTrack) {
        throw new Error(t('meetings.recordingNeedsVideo'))
      }

      // O áudio concedido é o da aba do Meet: contém os outros participantes,
      // não a voz local — o Meet não faz playback do próprio microfone. Sem este
      // mix a gravação sai sem quem está falando deste lado. Best-effort: mic
      // indisponível degrada para áudio de aba em vez de abortar a gravação.
      let micStream: MediaStream | null = null
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        sourceStreams.push(micStream)
      } catch (micError) {
        console.warn('[browser-toolbar] local mic unavailable, recording tab audio only', micError)
      }

      const audioTracks = [...displayStream.getAudioTracks(), ...(micStream?.getAudioTracks() ?? [])]
      let recordedAudioTracks = audioTracks
      if (audioTracks.length > 1) {
        audioContext = new AudioContext()
        const destination = audioContext.createMediaStreamDestination()
        for (const track of audioTracks) {
          audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination)
        }
        recordedAudioTracks = destination.stream.getAudioTracks()
      }
      if (audioTracks.length === 0) {
        // Vídeo sem áudio ainda é melhor que nada: avisa e continua, diferente da
        // ausência de vídeo, que aborta.
        console.warn('[browser-toolbar] no audio track captured; recording video only')
        setRecordingError(t('meetings.recordingNoAudio'))
      }

      const stream = new MediaStream([videoTrack, ...recordedAudioTracks])
      const recorder = new MediaRecorder(stream, { mimeType })
      const recordingId = prepared.recordingId
      const pendingChunks = new Set<Promise<void>>()
      recorder.ondataavailable = async (event) => {
        if (event.data.size === 0) return
        const appendChunk = (async () => {
          const buffer = await event.data.arrayBuffer()
          await api.appendRecordingChunk(recordingId, buffer)
        })()
        pendingChunks.add(appendChunk)
        try {
          await appendChunk
        } catch (error) {
          console.error('[browser-toolbar] recording chunk append failed', error)
        } finally {
          pendingChunks.delete(appendChunk)
        }
      }
      recorder.onerror = (event) => {
        console.error('[browser-toolbar] recorder error', event)
        setRecordingError('Recorder error')
        setRecordingState('error')
      }
      recordingRef.current = { id: recordingId, recorder, sourceStreams, audioContext, mimeType, pendingChunks }
      // Auto-stop when the captured surface goes away ("Stop sharing", frame
      // teardown). Escuta as faixas de ORIGEM: a faixa mixada é um destino de
      // AudioContext e nunca emite `ended`. Navegação para fora da reunião NÃO
      // encerra faixa nenhuma — quem cobre isso é o efeito acima.
      const onTrackEnded = (event: Event) => {
        const target = event.target as MediaStreamTrack | null
        console.info('[browser-toolbar] recording track ended, auto-finalizing', {
          recordingId,
          trackKind: target?.kind,
          trackLabel: target?.label,
        })
        void stopRecording('finalize')
      }
      displayStream.getTracks().forEach((track) => {
        track.addEventListener('ended', onTrackEnded, { once: true })
      })
      recorder.start(1000)
      setRecordingStartedAt(Date.now())
      setRecordingState('recording')
      console.info('[browser-toolbar] recording started', {
        recordingId,
        outputPath: prepared.outputPath,
        audioTracks: audioTracks.length,
        micIncluded: Boolean(micStream),
      })
    } catch (error) {
      console.error('[browser-toolbar] start recording failed', error)
      const message = error instanceof Error ? error.message : String(error)
      setRecordingError(message)
      setRecordingState('error')
      setActiveRecordingMeetUrl(null)
      setRecordingStartedAt(null)
      stopCaptureSources({ sourceStreams, audioContext })
      if (prepared) {
        try { await api.abortRecording(prepared.recordingId) } catch { /* noop */ }
      }
    }
  }, [api, detectedMeetUrl, recordingState, stopRecording, t])

  useEffect(() => {
    return () => {
      const active = recordingRef.current
      if (!active) return
      recordingRef.current = null
      // Finalize on unmount so the partial .webm is persisted (the user may have
      // closed the pane before clicking Parar). Mirror stopRecording's sequence:
      // await recorder.onstop + drain pendingChunks before finalizeRecording, so
      // the last captured chunks are written before the file is closed.
      const finalize = async () => {
        if (active.recorder.state !== 'inactive') {
          await new Promise<void>((resolve) => {
            active.recorder.onstop = () => resolve()
            active.recorder.stop()
          })
        }
        while (active.pendingChunks.size > 0) {
          await Promise.allSettled(Array.from(active.pendingChunks))
        }
        stopCaptureSources(active)
        await api?.finalizeRecording(active.id, active.mimeType)
      }
      void finalize().catch((err) => {
        console.error('[browser-toolbar] finalize on unmount failed', err)
      })
    }
  }, [api])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  const inviteButtonTitle = inviteError ?? detectedMeetUrl ?? undefined
  const inviteButtonClassName = inviteState === 'error'
    ? 'titlebar-no-drag inline-flex h-8 shrink-0 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 text-xs font-semibold text-destructive shadow-minimal transition-colors hover:bg-destructive/15'
    : 'titlebar-no-drag inline-flex h-8 shrink-0 items-center rounded-lg border border-emerald-500/30 bg-emerald-500/12 px-2.5 text-xs font-semibold text-emerald-700 shadow-minimal transition-colors hover:bg-emerald-500/20 disabled:cursor-default disabled:opacity-70 dark:text-emerald-300'

  const hermesInviteButton = detectedMeetUrl ? (
    <button
      type="button"
      onClick={handleInviteHermes}
      disabled={inviteState === 'starting' || inviteState === 'sent'}
      className={inviteButtonClassName}
      title={inviteButtonTitle}
    >
      {inviteState === 'starting'
        ? t('meetings.inviteHermesCalling')
        : inviteState === 'sent'
          ? t('meetings.inviteHermesSent')
          : inviteState === 'error'
            ? t('meetings.inviteHermesFailed')
            : t('meetings.inviteHermes')}
    </button>
  ) : null

  // `tabular-nums`: o timer no label não pode fazer a largura do botão oscilar.
  const recordingButtonClassName = recordingState === 'recording'
    ? 'titlebar-no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/15 px-2.5 text-xs font-semibold tabular-nums text-red-700 shadow-minimal transition-colors hover:bg-red-500/25 dark:text-red-300'
    : recordingState === 'error'
      ? 'titlebar-no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 text-xs font-semibold text-destructive shadow-minimal transition-colors hover:bg-destructive/15'
      : 'titlebar-no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-foreground/[0.04] px-2.5 text-xs font-semibold text-foreground shadow-minimal transition-colors hover:bg-foreground/[0.08] disabled:cursor-default disabled:opacity-70'

  const recordingButton = recordingMeetUrl || recordingState !== 'idle' ? (
    <button
      type="button"
      onClick={handleToggleRecording}
      disabled={recordingState === 'preparing' || recordingState === 'stopping'}
      className={recordingButtonClassName}
      title={recordingError ?? (recordingState === 'recording' ? t('meetings.recordTooltipStop') : t('meetings.recordTooltipStart'))}
    >
      {recordingState === 'recording' ? <Square className="size-3.5" /> : <Video className="size-3.5" />}
      {recordingState === 'preparing'
        ? t('meetings.recordPreparing')
        : recordingState === 'stopping'
          ? t('meetings.recordSaving')
          : recordingState === 'recording'
            ? (recordingStartedAt === null
              ? t('meetings.recordStop')
              : t('meetings.recordStopWithElapsed', {
                elapsed: formatRecordingElapsed(recordingNow - recordingStartedAt),
              }))
            : recordingState === 'error'
              ? t('meetings.recordRetry')
              : t('meetings.recordStart')}
    </button>
  ) : null

  const meetActionsContent = (hermesInviteButton || recordingButton) ? (
    <div className="flex items-center gap-2">
      {hermesInviteButton}
      {recordingButton}
    </div>
  ) : null

  return (
    <>
      {/*
        Full-window outside-tap catcher while any menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {anyMenuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setWindowMenuOpen(false)
            setProfileMenuOpen(false)
          }}
        />
      )}

      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        leadingContent={meetActionsContent}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            {/* Bring the agent chat alongside the page, as a panel inside this
                window. With a bound session it shows that one, otherwise the
                session list, so the user can start one without leaving the
                browser.

                Hidden while docked: the app's own chat is already beside the
                browser there, so the panel would be the same session twice. */}
            {state.displayMode !== 'integrated' && (
              <HeaderIconButton
                icon={<PanelRight className="size-3.5" />}
                aria-label={t('browser.toggleSessionPanel', { defaultValue: 'Toggle session panel' })}
                title={t('browser.toggleSessionPanel', { defaultValue: 'Toggle session panel' })}
                onClick={() => { void api?.toggleSessionPanel() }}
                className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
              />
            )}
            {/* Dock/undock lives here rather than in the app's browser menu:
                the user is looking at this window when they decide it should
                move into the app, and reaching for a menu behind it to say so
                is backwards. The switch itself is completed by the app
                renderer, which owns the card. */}
            <HeaderIconButton
              icon={state.displayMode === 'integrated'
                ? <Monitor className="size-3.5" />
                : <PanelsTopLeft className="size-3.5" />}
              aria-label={dockLabel}
              title={dockLabel}
              onClick={() => {
                void api?.requestDisplayMode(state.displayMode === 'integrated' ? 'floating' : 'integrated')
              }}
              className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
            />
            {state.profile && (
              <ProfileMenu
                current={state.profile}
                profiles={state.availableProfiles ?? [state.profile]}
                open={profileMenuOpen}
                onOpenChange={setProfileMenuOpen}
                contentRef={profileMenuContentRef}
                onSwitch={(id) => {
                  setProfileMenuOpen(false)
                  void api?.switchProfile(id)
                }}
                onManage={() => {
                  setProfileMenuOpen(false)
                  void api?.requestProfileManagement()
                }}
              />
            )}
            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="size-3.5" />}
                  aria-label="Browser window options"
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                {detectedMeetUrl && (
                  <StyledDropdownMenuItem onSelect={handleInviteHermes}>
                    <Sparkles className="size-3.5" />
                    {inviteState === 'starting'
                      ? t('meetings.inviteHermesCalling')
                      : inviteState === 'sent'
                        ? t('meetings.inviteHermesSent')
                        : inviteState === 'error'
                          ? t('meetings.inviteHermesFailed')
                          : t('meetings.inviteHermes')}
                  </StyledDropdownMenuItem>
                )}
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  <EyeOff className="size-3.5" />
                  Hide Window
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="size-3.5" />
                  Close Window Entirely
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        themeColor={recordingActive ? null : themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

interface ProfileMenuProps {
  current: ToolbarProfile
  profiles: ToolbarProfile[]
  open: boolean
  onOpenChange: (open: boolean) => void
  contentRef: React.MutableRefObject<HTMLDivElement | null>
  onSwitch: (id: string) => void
  onManage: () => void
}

function ProfileMenu({
  current,
  profiles,
  open,
  onOpenChange,
  contentRef,
  onSwitch,
  onManage,
}: ProfileMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Perfil do navegador: ${current.name}`}
          title={`Perfil do navegador: ${current.name}${current.clientName ? ` • ${current.clientName}` : ''}`}
          className="flex h-7 max-w-[190px] items-center gap-1.5 rounded-full border border-border/70 bg-background/85 px-2 text-xs font-medium shadow-minimal transition hover:bg-foreground/5 hover:ring-2 hover:ring-foreground/20"
        >
          <span
            className="size-3 rounded-full shrink-0"
            style={{ backgroundColor: current.color }}
          />
          <span className="truncate">{current.name}</span>
          {current.kind === 'client' && (
            <span className="rounded-full bg-blue-500/12 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-blue-600 dark:text-blue-300">
              cliente
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent
        ref={contentRef}
        align="end"
        side="bottom"
        sideOffset={6}
        minWidth="min-w-44"
        className="titlebar-no-drag z-[110] max-h-none overflow-visible"
      >
        {profiles.map((p) => (
          <StyledDropdownMenuItem
            key={p.id}
            onSelect={() => {
              if (p.id !== current.id) onSwitch(p.id)
            }}
          >
            <div
              className="size-4 rounded-full flex items-center justify-center text-white text-[8px] font-semibold"
              style={{ backgroundColor: p.color }}
            >
              {(p.name?.trim().charAt(0) || '?').toUpperCase()}
            </div>
            <span className={p.id === current.id ? 'font-semibold' : undefined}>
              {p.name}
              {p.id === current.id ? ' ✓' : ''}
            </span>
          </StyledDropdownMenuItem>
        ))}
        <StyledDropdownMenuItem onSelect={onManage}>
          Gerenciar perfis…
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
