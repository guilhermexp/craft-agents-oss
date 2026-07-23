import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import type {
  MeetingRecord,
  MeetingTranscriptionConfig,
  MeetingStartInput,
  MeetingStatus,
  MeetingTranscriptionProvider,
  MeetingTranscriptResult,
  MeetingTranscriptSegment,
  SaveMeetingTranscriptionConfigInput,
} from '../../shared/types'
import { generateMeetingSummaryMarkdown } from './meeting-summary-service'
import { generateMeetingVideoAnalysisMarkdown } from './meeting-video-analysis-service'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { getHermesRuntimePaths } from '../handlers/hermes-runtime'
import { mainLog } from '../logger'
import { getCredentialManager, type CredentialId } from '@craft-agent/shared/credentials'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'

const execFileAsync = promisify(execFile)

const GOOGLE_MEET_HOSTS = new Set(['meet.google.com', 'www.meet.google.com'])
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i
const COMPACT_MEET_CODE_RE = /^[a-z]{10}$/i
export const HERMES_PLUGIN_TIMEOUT_MS: Record<'start' | 'status' | 'transcript' | 'stop', number> = {
  start: 60_000, // pm.start faz spawn+handshake do bot Playwright
  status: 10_000,
  transcript: 15_000,
  stop: 15_000,
}
const DEFAULT_TRANSCRIPTION_PROVIDER: MeetingTranscriptionProvider = 'deepgram'
const DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER: Record<MeetingTranscriptionProvider, string> = {
  deepgram: 'nova-3',
}
const DEFAULT_MEETING_TRANSCRIPTION_CONFIG: Omit<MeetingTranscriptionConfig, 'hasApiKey'> = {
  provider: DEFAULT_TRANSCRIPTION_PROVIDER,
  model: DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER[DEFAULT_TRANSCRIPTION_PROVIDER],
}

interface PersistedMeetingsStore {
  version?: number
  meetings: MeetingRecord[]
}

interface PersistedMeetingTranscriptionConfig {
  version?: number
  transcription?: {
    provider?: MeetingTranscriptionProvider
    model?: string
  }
}

interface WorkspaceMeetingState {
  records: Map<string, MeetingRecord>
  transcripts: Map<string, MeetingTranscriptResult>
  loaded: boolean
  corruptDetected: boolean
  storePath: string
  configPath: string
  transcriptsDir: string
  summariesDir: string
}

type MeetingVideoAnalysisGenerator = typeof generateMeetingVideoAnalysisMarkdown

interface HermesMeetPluginResult {
  ok?: boolean
  error?: string
  reason?: string
  pid?: string | number
  meeting_id?: string
  meetingId?: string
  alive?: boolean
  inCall?: boolean
  lobbyWaiting?: boolean
  leaveReason?: string
  exited?: boolean
  [key: string]: unknown
}

export class MeetingService {
  private readonly workspaceStates = new Map<string, WorkspaceMeetingState>()
  private readonly healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * Deadline for the Hermes bot to reach the lobby/call before start() fails.
   * Mutable so tests can shrink the real-time wait in `waitForHermesMeetBotReady`.
   */
  private botReadyTimeoutMs = 20_000

  constructor(
    private readonly browserPaneManager: BrowserPaneManager,
    private readonly storePathOverride?: string,
    private readonly videoAnalysisGenerator: MeetingVideoAnalysisGenerator = generateMeetingVideoAnalysisMarkdown,
  ) {}

  async getTranscriptionConfig(workspaceId: string, workspaceRootPath: string): Promise<MeetingTranscriptionConfig> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const config = this.loadTranscriptionConfig(state)
    const credential = await getCredentialManager().get(getTranscriptionCredentialId(workspaceId, config.provider))
    return {
      ...config,
      hasApiKey: Boolean(credential?.value),
    }
  }

  async saveTranscriptionConfig(
    workspaceId: string,
    workspaceRootPath: string,
    input: SaveMeetingTranscriptionConfigInput,
  ): Promise<MeetingTranscriptionConfig> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const provider = normalizeTranscriptionProvider(input.provider, { strict: true })
    const model = normalizeTranscriptionModel(input.model, provider)
    this.persistTranscriptionConfig(state, { provider, model })

    const credentialId = getTranscriptionCredentialId(workspaceId, provider)
    if (input.apiKey !== undefined) {
      const apiKey = input.apiKey.trim()
      if (apiKey) {
        await getCredentialManager().set(credentialId, { value: apiKey })
      } else {
        await getCredentialManager().delete(credentialId)
      }
    }

    const credential = await getCredentialManager().get(credentialId)
    return {
      provider,
      model,
      hasApiKey: Boolean(credential?.value),
    }
  }

  async start(workspaceRootPath: string, input: string | MeetingStartInput): Promise<MeetingRecord> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const payload = typeof input === 'string' ? { urlOrCode: input } : input
    const savedTranscriptionConfig = this.loadTranscriptionConfig(state)
    const normalized = normalizeGoogleMeetUrl(payload?.urlOrCode)
    const captureMode: 'hermes' | 'craft' = payload.captureMode ?? (payload.transcribe === false ? 'craft' : 'hermes')
    // The google_meet plugin bot is a per-HERMES_HOME singleton; only craft-mode
    // meetings (or hermes meetings with transcription off) skip it.
    const usesHermesBot = captureMode === 'hermes' && payload.transcribe !== false
    if (usesHermesBot) {
      const active = this.findActiveHermesMeeting()
      if (active) {
        throw new Error(t('meetings.hermesBotBusy', { url: active.url }))
      }
    }
    const transcriptionProvider = payload.transcribe === false
      ? undefined
      : normalizeTranscriptionProvider(
        payload.transcriptionProvider ?? savedTranscriptionConfig.provider,
        { strict: payload.transcriptionProvider != null },
      )
    const transcriptionModel = transcriptionProvider
      ? normalizeTranscriptionModel(payload.transcriptionModel ?? savedTranscriptionConfig.model, transcriptionProvider)
      : undefined
    const now = Date.now()
    const id = randomUUID()
    const requestedBrowserInstanceId = typeof payload?.browserInstanceId === 'string'
      ? payload.browserInstanceId
      : undefined
    const existingBrowserInstance = requestedBrowserInstanceId
      ? this.browserPaneManager.getInstance(requestedBrowserInstanceId)
      : undefined
    const browserInstanceId = existingBrowserInstance?.id
      ?? this.browserPaneManager.createInstance(undefined, {
        show: true,
        profileId: payload?.profileId,
      })

    const record: MeetingRecord = {
      id,
      provider: 'google-meet',
      captureMode,
      status: 'starting',
      url: normalized.url,
      code: normalized.code,
      browserInstanceId,
      ownsBrowserInstance: !existingBrowserInstance,
      title: payload?.title,
      startedAt: now,
      updatedAt: now,
      endedAt: undefined,
      error: undefined,
      transcriptionProvider,
      transcriptionModel,
      summarizeOnEnd: payload.summarizeOnEnd,
      followUpOnEnd: payload.followUpOnEnd,
      summaryMarkdown: createMeetingSummaryMarkdown({
        title: payload?.title,
        url: normalized.url,
        captureMode,
        transcriptionProvider,
        transcriptionModel,
        status: 'starting',
        startedAt: now,
      }),
    }

    state.records.set(id, record)
    const placeholder = createTranscriptPlaceholder(record)
    state.transcripts.set(id, placeholder)
    this.persist(state)
    this.persistTranscript(state, placeholder)
    let botStarted = false

    try {
      // If the meeting was detected from an already-open Browser Pane, reuse it
      // instead of creating/navigating another user browser. The separate Hermes
      // bot is started below by the google_meet Playwright process.
      if (!existingBrowserInstance) {
        await this.browserPaneManager.navigate(browserInstanceId, normalized.url)
        this.browserPaneManager.focus(browserInstanceId)
      }

      if (usesHermesBot) {
        mainLog.info(`[meetings] starting Hermes Meet bot url=${normalized.url} profileId=${payload.profileId ?? 'default'} browserInstanceId=${browserInstanceId}`)
        const botStart = await this.runHermesMeetPlugin('start', { url: normalized.url, headed: true })
        if (!botStart.ok) {
          throw new Error(botStart.error || botStart.reason || 'Hermes Google Meet bot did not start')
        }
        botStarted = true
        const botStatus = await this.waitForHermesMeetBotReady(botStart, this.botReadyTimeoutMs)
        mainLog.info(`[meetings] Hermes Meet bot start result pid=${botStart.pid ?? 'unknown'} alive=${String(botStatus.alive ?? 'unknown')} meetingId=${botStatus.meetingId ?? botStart.meeting_id ?? 'unknown'} inCall=${String(botStatus.inCall ?? false)} lobbyWaiting=${String(botStatus.lobbyWaiting ?? false)} error=${botStatus.error ?? 'none'} leaveReason=${botStatus.leaveReason ?? 'none'}`)
        if (botStatus.ok && (botStatus.inCall || botStatus.lobbyWaiting)) {
          // Good: the bot either joined directly or is waiting for host approval.
        } else if (botStatus.error) {
          throw new Error(`Hermes Google Meet bot failed: ${botStatus.error}`)
        } else if (botStatus.leaveReason) {
          throw new Error(`Hermes Google Meet bot left before joining: ${botStatus.leaveReason}`)
        } else {
          throw new Error('Hermes Google Meet bot started, but did not reach the lobby or the call. Configure a dedicated Hermes Google account instead of using the organizer account.')
        }
      }

      this.updateRecord(state, id, {
        status: 'running',
        error: undefined,
        summaryMarkdown: createMeetingSummaryMarkdown({
          title: payload?.title,
          url: normalized.url,
          captureMode,
          transcriptionProvider,
          transcriptionModel,
          status: 'running',
          startedAt: now,
        }),
      })
      if (usesHermesBot) {
        this.startHealthCheck(state, id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.error(`[meetings] start failed id=${id} url=${normalized.url}: ${message}`)
      if (usesHermesBot && botStarted) {
        void this.runHermesMeetPlugin('stop').catch(() => undefined)
      }
      this.updateRecord(state, id, {
        status: 'error',
        error: message,
      })
    }

    return this.getRequired(state, id)
  }

  /** The google_meet plugin bot is a singleton per HERMES_HOME. */
  private findActiveHermesMeeting(): MeetingRecord | null {
    for (const state of this.workspaceStates.values()) {
      for (const record of state.records.values()) {
        if (record.captureMode !== 'craft' && ['starting', 'running'].includes(record.status)) {
          return record
        }
      }
    }
    return null
  }

  list(workspaceRootPath: string, options?: { includeArchived?: boolean }): MeetingRecord[] {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    const records = [...state.records.values()].sort((a, b) => b.startedAt - a.startedAt)
    if (options?.includeArchived) return records
    return records.filter((r) => !r.isArchived)
  }

  status(workspaceRootPath: string, id: string): MeetingRecord | null {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    return state.records.get(id) ?? null
  }

  stop(workspaceId: string, workspaceRootPath: string, id: string): MeetingRecord {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = this.getRequired(state, id)
    this.stopHealthCheck(id)
    if (record.status === 'stopped') {
      return record
    }

    try {
      if (record.captureMode !== 'craft') {
        void this.finalizeHermesCapture(workspaceId, workspaceRootPath, id).catch((err) => {
          mainLog.error(`[meetings] finalizeHermesCapture failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      if (record.ownsBrowserInstance) {
        this.browserPaneManager.destroyInstance(record.browserInstanceId)
      }
      const endedAt = Date.now()
      this.updateRecord(state, id, {
        status: 'stopped',
        endedAt,
        error: undefined,
        summaryMarkdown: createMeetingSummaryMarkdown({
          title: record.title,
          url: record.url,
          captureMode: record.captureMode ?? 'hermes',
          transcriptionProvider: record.transcriptionProvider,
          transcriptionModel: record.transcriptionModel,
          status: 'stopped',
          startedAt: record.startedAt,
          endedAt,
        }),
      })
    } catch (error) {
      this.updateRecord(state, id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return this.getRequired(state, id)
  }

  archive(workspaceRootPath: string, id: string): MeetingRecord {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.getRequired(state, id)
    this.updateRecord(state, id, { isArchived: true, archivedAt: Date.now() } as Partial<MeetingRecord>)
    return this.getRequired(state, id)
  }

  unarchive(workspaceRootPath: string, id: string): MeetingRecord {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.getRequired(state, id)
    this.updateRecord(state, id, { isArchived: undefined, archivedAt: undefined } as Partial<MeetingRecord>)
    return this.getRequired(state, id)
  }

  deleteMeeting(workspaceRootPath: string, id: string): void {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = state.records.get(id)
    if (!record) return
    if (['starting', 'running'].includes(record.status)) {
      this.stopHealthCheck(id)
      if (record.captureMode !== 'craft') {
        void this.runHermesMeetPlugin('stop').catch(() => undefined)
      }
      if (record.ownsBrowserInstance) {
        try { this.browserPaneManager.destroyInstance(record.browserInstanceId) } catch { /* pane já fechado */ }
      }
    }
    state.records.delete(id)
    state.transcripts.delete(id)
    this.persist(state)
    // Remove transcript file
    const transcriptPath = join(state.transcriptsDir, `${safeFileId(id)}.json`)
    try { if (existsSync(transcriptPath)) unlinkSync(transcriptPath) } catch {}
    // Remove summary file
    const summaryPath = join(state.summariesDir, `${safeFileId(id)}.md`)
    try { if (existsSync(summaryPath)) unlinkSync(summaryPath) } catch {}
    // Remove recording file if stored
    if (record.recording?.path) {
      try { if (existsSync(record.recording.path)) unlinkSync(record.recording.path) } catch {}
    }
    // Remove generated video-analysis evidence (contact sheets, frames, audio)
    try { rmSync(this.getVideoAnalysisDir(state, id), { recursive: true, force: true }) } catch {}
  }

  async completeRecording(
    workspaceId: string,
    workspaceRootPath: string,
    meetingId: string,
    recording: { outputPath: string; bytesWritten: number; durationMs: number; mimeType?: string },
  ): Promise<void> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = state.records.get(meetingId)
    if (!record) return

    const endedAt = Date.now()
    const processingSummary = createMeetingSummaryMarkdown({
      title: record.title,
      url: record.url,
      captureMode: record.captureMode ?? 'craft',
      transcriptionProvider: record.transcriptionProvider,
      transcriptionModel: record.transcriptionModel,
      status: 'stopped',
      startedAt: record.startedAt,
      endedAt,
      summaryBody: record.transcriptionProvider && record.transcriptionModel
        ? t('meetings.summaryDocBodyProcessing')
        : t('meetings.summaryDocBodyNoTranscription'),
    })

    this.updateRecord(state, meetingId, {
      status: 'stopped',
      endedAt,
      recording: {
        path: recording.outputPath,
        mimeType: recording.mimeType,
        bytesWritten: recording.bytesWritten,
        durationMs: recording.durationMs,
      },
      summaryMarkdown: processingSummary,
    } as Partial<MeetingRecord>)

    if (record.transcriptionProvider && record.transcriptionModel) {
      const transcript: MeetingTranscriptResult = {
        meetingId,
        status: 'capturing',
        transcript: [],
        summaryMarkdown: processingSummary,
        message: t('meetings.transcriptProcessingMessage'),
        updatedAt: Date.now(),
      }
      state.transcripts.set(meetingId, transcript)
      this.persistTranscript(state, transcript)
      void this.transcribeRecording(workspaceId, workspaceRootPath, meetingId).catch((err) => {
        mainLog.error(`[meetings] transcription failed for ${meetingId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    const updatedRecord = state.records.get(meetingId)
    if (!updatedRecord?.transcriptionProvider || !updatedRecord.transcriptionModel) {
      void this.generateAgentVideoAnalysis(workspaceId, workspaceRootPath, meetingId, [])
    }
  }

  /**
   * Boot-time recovery for transcripts interrupted by a crash/quit while in
   * `capturing` (completeRecording persists that status before the
   * fire-and-forget transcribeRecording finishes). Re-dispatches the
   * transcription when the recorded audio still exists and the record has a
   * provider/model (transcribeRecording itself demotes to `unavailable` on
   * missing key or network failure); otherwise demotes to `unavailable` with
   * an actionable message. No `capturing` orphan survives a boot.
   */
  async recoverInterruptedTranscriptions(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    for (const record of [...state.records.values()]) {
      const transcript = state.transcripts.get(record.id)
      if (transcript?.status !== 'capturing') continue

      const canRetry = Boolean(
        record.recording?.path
        && existsSync(record.recording.path)
        && record.transcriptionProvider
        && record.transcriptionModel,
      )
      if (canRetry) {
        mainLog.info(`[meetings] resuming transcription interrupted by app shutdown for ${record.id}`)
        void this.transcribeRecording(workspaceId, workspaceRootPath, record.id).catch((err) => {
          mainLog.error(`[meetings] transcription recovery failed for ${record.id}: ${err instanceof Error ? err.message : String(err)}`)
        })
        continue
      }

      const summaryMarkdown = createMeetingSummaryMarkdown({
        title: record.title,
        url: record.url,
        captureMode: record.captureMode ?? 'craft',
        transcriptionProvider: record.transcriptionProvider,
        transcriptionModel: record.transcriptionModel,
        status: 'stopped',
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        summaryBody: t('meetings.summaryDocBodyInterrupted'),
      })
      const unavailable: MeetingTranscriptResult = {
        meetingId: record.id,
        status: 'unavailable',
        transcript: [],
        message: t('meetings.transcriptInterruptedMessage'),
        summaryMarkdown,
        updatedAt: Date.now(),
      }
      state.transcripts.set(record.id, unavailable)
      this.persistTranscript(state, unavailable)
      this.updateRecord(state, record.id, { summaryMarkdown })
      mainLog.warn(`[meetings] demoted interrupted transcription without recoverable audio for ${record.id}`)
    }
  }

  async transcribeRecording(workspaceId: string, workspaceRootPath: string, meetingId: string): Promise<void> {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = state.records.get(meetingId)
    if (!record?.recording?.path || !record.transcriptionProvider || !record.transcriptionModel) return

    const credentialId = getTranscriptionCredentialId(workspaceId, record.transcriptionProvider)
    const credential = await getCredentialManager().get(credentialId)
    if (!credential?.value) {
      const summaryMarkdown = createMeetingSummaryMarkdown({
        title: record.title,
        url: record.url,
        captureMode: record.captureMode ?? 'craft',
        transcriptionProvider: record.transcriptionProvider,
        transcriptionModel: record.transcriptionModel,
        status: 'stopped',
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        summaryBody: t('meetings.summaryDocBodyMissingKey'),
      })
      const unavailable: MeetingTranscriptResult = {
        meetingId,
        status: 'unavailable',
        transcript: [],
        message: t('meetings.transcriptMissingKeyMessage'),
        summaryMarkdown,
        updatedAt: Date.now(),
      }
      state.transcripts.set(meetingId, unavailable)
      this.persistTranscript(state, unavailable)
      this.updateRecord(state, meetingId, { summaryMarkdown })
      void this.generateAgentVideoAnalysis(workspaceId, workspaceRootPath, meetingId, [])
      return
    }

    try {
      const { TranscriptionService } = await import('./transcription-service')
      const service = new TranscriptionService()
      const result = await service.transcribe({
        filePath: record.recording.path,
        model: record.transcriptionModel,
        apiKey: credential.value,
        mimeType: record.recording.mimeType,
      })
      const currentRecord = state.records.get(meetingId) ?? record
      const message = result.segments.length > 0
        ? t('meetings.transcriptCompletedMessage', { count: result.segments.length })
        : t('meetings.transcriptCompletedEmptyMessage')
      const summaryMarkdown = createMeetingSummaryMarkdown({
        title: currentRecord.title,
        url: currentRecord.url,
        captureMode: currentRecord.captureMode ?? 'craft',
        transcriptionProvider: currentRecord.transcriptionProvider,
        transcriptionModel: currentRecord.transcriptionModel,
        status: 'stopped',
        startedAt: currentRecord.startedAt,
        endedAt: currentRecord.endedAt,
        summaryBody: message,
      })
      const transcript: MeetingTranscriptResult = {
        meetingId,
        status: 'ready',
        transcript: result.segments,
        summaryMarkdown,
        message,
        updatedAt: Date.now(),
      }
      state.transcripts.set(meetingId, transcript)
      this.persistTranscript(state, transcript)
      this.updateRecord(state, meetingId, { summaryMarkdown })

      // Hand every completed recording to the configured Craft agent for a
      // video-aware post-meeting analysis. It keeps Deepgram as the STT source,
      // but adds visual evidence (contact sheet + frames) from the recorded WebM.
      // The fire-and-forget analysis replaces the boilerplate summary when done.
      if (currentRecord.recording?.path) {
        void this.generateAgentVideoAnalysis(workspaceId, workspaceRootPath, meetingId, result.segments)
      } else if ((currentRecord.summarizeOnEnd || currentRecord.followUpOnEnd) && result.segments.length > 0) {
        void this.generateAgentSummary(workspaceId, workspaceRootPath, meetingId, result.segments)
      }
    } catch (error) {
      const currentRecord = state.records.get(meetingId) ?? record
      const message = error instanceof Error ? error.message : String(error)
      const summaryMarkdown = createMeetingSummaryMarkdown({
        title: currentRecord.title,
        url: currentRecord.url,
        captureMode: currentRecord.captureMode ?? 'craft',
        transcriptionProvider: currentRecord.transcriptionProvider,
        transcriptionModel: currentRecord.transcriptionModel,
        status: 'stopped',
        startedAt: currentRecord.startedAt,
        endedAt: currentRecord.endedAt,
        summaryBody: t('meetings.summaryDocBodyTranscribeFailed', { message }),
      })
      const unavailable: MeetingTranscriptResult = {
        meetingId,
        status: 'unavailable',
        transcript: [],
        summaryMarkdown,
        message,
        updatedAt: Date.now(),
      }
      state.transcripts.set(meetingId, unavailable)
      this.persistTranscript(state, unavailable)
      this.updateRecord(state, meetingId, { summaryMarkdown })
      void this.generateAgentVideoAnalysis(workspaceId, workspaceRootPath, meetingId, [])
      throw error
    }
  }

  /**
   * Pós-processamento de reuniões capturadas pelo bot Hermes: busca o transcript
   * do plugin ANTES de encerrar o bot (stop limpa o ponteiro ativo), persiste o
   * resultado e dispara o summary quando summarizeOnEnd/followUpOnEnd estão setados.
   * Fire-and-forget a partir de stop(), espelhando completeRecording (craft mode).
   */
  private async finalizeHermesCapture(workspaceId: string, workspaceRootPath: string, meetingId: string): Promise<void> {
    const state = this.getWorkspaceState(workspaceRootPath)
    const record = state.records.get(meetingId)
    if (!record || record.captureMode === 'craft') return

    let lines: string[] = []
    try {
      const res = await this.runHermesMeetPlugin('transcript')
      const rawLines = res.lines
      if (res.ok && Array.isArray(rawLines)) {
        lines = rawLines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      }
    } catch { /* best-effort: segue para o stop mesmo sem transcript */ }

    void this.runHermesMeetPlugin('stop').catch(() => undefined)

    const now = Date.now()
    const segments: MeetingTranscriptSegment[] = lines.map((line, index) => {
      const match = /^([^:]{1,60}):\s+(.*)$/.exec(line)
      return {
        id: `${meetingId}-${index}`,
        speaker: match?.[1],
        text: line,
        timestamp: now,
      }
    })

    const current = state.records.get(meetingId)
    if (!current) return
    const message = segments.length > 0
      ? t('meetings.transcriptCompletedMessage', { count: segments.length })
      : t('meetings.hermesTranscriptEmptyMessage')
    const summaryMarkdown = createMeetingSummaryMarkdown({
      title: current.title,
      url: current.url,
      captureMode: 'hermes',
      transcriptionProvider: current.transcriptionProvider,
      transcriptionModel: current.transcriptionModel,
      status: 'stopped',
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      summaryBody: message,
    })
    const transcript: MeetingTranscriptResult = {
      meetingId,
      status: segments.length > 0 ? 'ready' : 'unavailable',
      transcript: segments,
      summaryMarkdown,
      message,
      updatedAt: Date.now(),
    }
    state.transcripts.set(meetingId, transcript)
    this.persistTranscript(state, transcript)
    this.updateRecord(state, meetingId, { summaryMarkdown })

    if ((current.summarizeOnEnd || current.followUpOnEnd) && segments.length > 0) {
      await this.generateAgentSummary(workspaceId, workspaceRootPath, meetingId, segments)
    }
  }

  /**
   * Run the configured Craft agent (Claude/Pi, never Hermes) on the recorded
   * meeting video plus Deepgram transcript segments to produce visual notes.
   * Best-effort: failures keep the existing summary and are logged.
   */
  private async generateAgentVideoAnalysis(
    workspaceId: string,
    workspaceRootPath: string,
    meetingId: string,
    segments: MeetingTranscriptSegment[],
  ): Promise<void> {
    try {
      const state = this.getWorkspaceState(workspaceRootPath)
      const record = state.records.get(meetingId)
      const recordingPath = record?.recording?.path
      if (!record || !recordingPath) return

      const markdown = await this.videoAnalysisGenerator({
        workspaceId,
        workspaceRootPath,
        record,
        recordingPath,
        outputDir: this.getVideoAnalysisDir(state, meetingId),
        segments,
      })
      if (!markdown) {
        if ((record.summarizeOnEnd || record.followUpOnEnd) && segments.length > 0) {
          await this.generateAgentSummary(workspaceId, workspaceRootPath, meetingId, segments)
        }
        return
      }

      const latest = this.getWorkspaceState(workspaceRootPath)
      if (!latest.records.has(meetingId)) return
      this.updateRecord(latest, meetingId, { summaryMarkdown: markdown })
      mainLog.info(`[meetings] agent video analysis generated for ${meetingId}`)
    } catch (error) {
      mainLog.error(
        `[meetings] generateAgentVideoAnalysis failed for ${meetingId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Legacy text-only fallback for non-recorded transcript sources.
   */
  private async generateAgentSummary(
    workspaceId: string,
    workspaceRootPath: string,
    meetingId: string,
    segments: MeetingTranscriptSegment[],
  ): Promise<void> {
    try {
      const state = this.getWorkspaceState(workspaceRootPath)
      const record = state.records.get(meetingId)
      if (!record) return

      const markdown = await generateMeetingSummaryMarkdown({
        workspaceId,
        workspaceRootPath,
        record,
        segments,
      })
      if (!markdown) return

      // The record may have been deleted/archived while the agent ran.
      const latest = this.getWorkspaceState(workspaceRootPath)
      if (!latest.records.has(meetingId)) return
      this.updateRecord(latest, meetingId, { summaryMarkdown: markdown })
      mainLog.info(`[meetings] agent summary generated for ${meetingId}`)
    } catch (error) {
      mainLog.error(
        `[meetings] generateAgentSummary failed for ${meetingId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  transcript(workspaceRootPath: string, id: string): MeetingTranscriptResult {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = state.records.get(id)
    if (!record) {
      throw new Error(`Meeting not found: ${id}`)
    }

    const existing = state.transcripts.get(id)
    if (existing) return existing

    const stored = this.loadTranscript(state, id)
    if (stored) {
      state.transcripts.set(id, stored)
      return stored
    }

    const placeholder = createTranscriptPlaceholder(record)
    state.transcripts.set(id, placeholder)
    this.persistTranscript(state, placeholder)
    return placeholder
  }

  private async waitForHermesMeetBotReady(botStart: HermesMeetPluginResult, timeoutMs: number): Promise<HermesMeetPluginResult> {
    const deadline = Date.now() + timeoutMs
    let lastStatus: HermesMeetPluginResult = botStart

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      lastStatus = await this.runHermesMeetPlugin('status')
      if (lastStatus.inCall || lastStatus.lobbyWaiting || lastStatus.error || lastStatus.leaveReason || lastStatus.exited === true) {
        return lastStatus
      }
    }

    return lastStatus
  }

  private startHealthCheck(state: WorkspaceMeetingState, meetingId: string): void {
    if (this.healthCheckTimers.has(meetingId)) return

    const timer = setInterval(async () => {
      const record = state.records.get(meetingId)
      if (!record || !['running', 'starting'].includes(record.status)) {
        this.stopHealthCheck(meetingId)
        return
      }
      if (record.captureMode !== 'hermes') {
        this.stopHealthCheck(meetingId)
        return
      }

      try {
        const status = await this.runHermesMeetPlugin('status', {}, { timeoutMs: 5_000 })
        if (status.exited || status.error || status.leaveReason) {
          mainLog.warn(`[meetings] health-check: bot exited for ${meetingId}: error=${status.error ?? 'none'} leaveReason=${status.leaveReason ?? 'none'}`)
          this.updateRecord(state, meetingId, {
            status: 'error',
            error: status.error || status.leaveReason || 'Hermes bot exited unexpectedly',
            endedAt: Date.now(),
          })
          this.stopHealthCheck(meetingId)
        }
      } catch (err) {
        mainLog.warn(`[meetings] health-check failed for ${meetingId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 30_000)

    this.healthCheckTimers.set(meetingId, timer)
  }

  private stopHealthCheck(meetingId: string): void {
    const timer = this.healthCheckTimers.get(meetingId)
    if (timer) {
      clearInterval(timer)
      this.healthCheckTimers.delete(meetingId)
    }
  }

  private async runHermesMeetPlugin(
    command: 'start' | 'status' | 'transcript' | 'stop',
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<HermesMeetPluginResult> {
    const runtime = getHermesRuntimePaths()
    if (!runtime) {
      return { ok: false, error: 'Hermes runtime is not available. Rebuild/bundle Hermes before using meeting bots.' }
    }

    const script = String.raw`
import json, sys
from pathlib import Path
from plugins.google_meet import process_manager as pm
from plugins.google_meet.tools import check_meet_requirements

command = sys.argv[1]
payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
try:
    if command == 'check':
        print(json.dumps({'ok': bool(check_meet_requirements())}))
    elif command == 'start':
        if not check_meet_requirements():
            print(json.dumps({
                'ok': False,
                'error': 'Hermes Google Meet plugin is not ready: Playwright/Chromium is missing. Run the plugin setup before starting the bot.'
            }))
        else:
            from hermes_constants import get_hermes_home
            auth_path = Path(get_hermes_home()) / 'workspace' / 'meetings' / 'bot-auth.json'
            if not auth_path.is_file():
                print(json.dumps({
                    'ok': False,
                    'error': 'Hermes Google Meet bot is not authenticated. Run apps/electron/scripts/create-meet-bot-auth.py with the bundled Hermes venv and sign in with a dedicated bot Google account.'
                }))
                sys.exit(0)
            res = pm.start(
                url=str(payload.get('url') or ''),
                headed=bool(payload.get('headed', False)),
                guest_name=str(payload.get('guest_name') or 'Hermes Agent'),
                duration=str(payload.get('duration')) if payload.get('duration') else None,
                auth_state=str(auth_path),
                mode=str(payload.get('mode') or 'transcribe'),
            )
            print(json.dumps(res))
    elif command == 'status':
        print(json.dumps(pm.status()))
    elif command == 'transcript':
        print(json.dumps(pm.transcript(last=payload.get('last'))))
    elif command == 'stop':
        print(json.dumps(pm.stop(reason='Craft Meetings stopped')))
    else:
        print(json.dumps({'ok': False, 'error': f'Unknown command: {command}'}))
except Exception as exc:
    print(json.dumps({'ok': False, 'error': str(exc)}))
`

    let stdout: string
    try {
      ;({ stdout } = await execFileAsync(runtime.python, ['-c', script, command, JSON.stringify(payload)], {
        cwd: runtime.hermesAgentRoot,
        env: {
          ...process.env,
          HERMES_HOME: runtime.hermesHome,
          VIRTUAL_ENV: runtime.virtualEnv,
          PATH: `${runtime.vendorBinDir}:${process.env.PATH ?? ''}`,
        },
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs ?? HERMES_PLUGIN_TIMEOUT_MS[command],
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `Hermes Meet plugin '${command}' failed or timed out: ${message}` }
    }

    try {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      const parsed = JSON.parse(lines.at(-1) || '{}') as unknown
      if (parsed && typeof parsed === 'object') {
        return parsed as HermesMeetPluginResult
      }
      return { ok: false, error: 'Hermes Meet plugin returned a non-object response.' }
    } catch (error) {
      return { ok: false, error: `Could not parse Hermes Meet plugin output: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private getRequired(state: WorkspaceMeetingState, id: string): MeetingRecord {
    const record = state.records.get(id)
    if (!record) {
      throw new Error(`Meeting not found: ${id}`)
    }
    return record
  }

  private updateRecord(state: WorkspaceMeetingState, id: string, updates: Partial<MeetingRecord> & { summaryMarkdown?: string | null }): void {
    const existing = this.getRequired(state, id)
    const next: MeetingRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
      summaryMarkdown: hasOwn(updates, 'summaryMarkdown')
        ? (updates.summaryMarkdown || undefined)
        : existing.summaryMarkdown,
    }
    state.records.set(id, next)
    this.persist(state)
    if (hasOwn(updates, 'summaryMarkdown')) {
      if (next.summaryMarkdown) {
        this.persistSummaryMarkdown(state, next)
      } else {
        this.deleteSummaryMarkdown(state, id)
      }

      const existingTranscript = state.transcripts.get(id)
      if (existingTranscript) {
        const nextTranscript = {
          ...existingTranscript,
          updatedAt: Date.now(),
        }
        if (next.summaryMarkdown) {
          nextTranscript.summaryMarkdown = next.summaryMarkdown
        } else {
          delete nextTranscript.summaryMarkdown
        }
        state.transcripts.set(id, nextTranscript)
        this.persistTranscript(state, nextTranscript)
      }
    }
  }

  private refreshLiveStatuses(state: WorkspaceMeetingState): void {
    let changed = false
    for (const record of state.records.values()) {
      if (!['starting', 'running'].includes(record.status)) continue
      const instance = this.browserPaneManager.getInstance(record.browserInstanceId)
      if (instance) continue
      state.records.set(record.id, {
        ...record,
        status: 'stopped',
        endedAt: record.endedAt ?? Date.now(),
        updatedAt: Date.now(),
      })
      if (record.captureMode !== 'craft') {
        this.stopHealthCheck(record.id)
        void this.runHermesMeetPlugin('stop').catch(() => undefined)
      }
      changed = true
    }
    if (changed) this.persist(state)
  }

  private ensureLoaded(state: WorkspaceMeetingState): void {
    if (state.loaded) return
    try {
      if (!existsSync(state.storePath)) {
        this.persist(state)
        state.loaded = true
        this.reconcileOrphanRecordings(state)
        return
      }
      const parsed = readJsonFileSync<PersistedMeetingsStore>(state.storePath)
      for (const record of Array.isArray(parsed.meetings) ? parsed.meetings : []) {
        const safeRecord = sanitizeRecord(record)
        if (safeRecord) {
          state.records.set(safeRecord.id, safeRecord)
          state.transcripts.set(safeRecord.id, this.loadTranscript(state, safeRecord.id) ?? createTranscriptPlaceholder(safeRecord))
        }
      }
      state.loaded = true
      this.reconcileOrphanRecordings(state)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.error(`[meetings] failed to load persisted meetings from ${state.storePath}: ${message}`)
      state.corruptDetected = true
      const backupPath = `${state.storePath}.corrupt-${Date.now()}`
      try {
        renameSync(state.storePath, backupPath)
        mainLog.warn(`[meetings] unreadable meetings store moved to ${backupPath}; continuing with an empty store`)
        state.loaded = true
      } catch (renameError) {
        // Sem backup garantido, escrever destruiria a única cópia dos dados —
        // falhe alto em vez de deixar o próximo persist() sobrescrever.
        throw new Error(
          `Meetings store at ${state.storePath} is unreadable and could not be backed up: ${message} ` +
          `(backup failed: ${renameError instanceof Error ? renameError.message : String(renameError)})`,
        )
      }
    }
  }

  /**
   * Scan the workspace's `recordings/` directory and delete any `.webm` file
   * that is not referenced by a persisted meeting record. These orphans
   * accumulate when the renderer (or the app) crashed mid-recording, or when
   * the toolbar unmounted against an older build that aborted instead of
   * finalizing. Deleting on startup keeps disk usage bounded and prevents the
   * Media Pane from listing files that no meeting owns.
   *
   * Runs once per workspace (the first time `ensureLoaded` is called), so it
   * cannot race with an in-flight recording in the same workspace.
   */
  private reconcileOrphanRecordings(state: WorkspaceMeetingState): void {
    const meetingsDir = dirname(state.storePath)
    let corruptBackupPresent = false
    try {
      corruptBackupPresent = existsSync(meetingsDir)
        && readdirSync(meetingsDir).some((entry) => entry.startsWith('meetings.json.corrupt-'))
    } catch { /* dir ilegível: trate como presente para não varrer */ corruptBackupPresent = true }
    if (corruptBackupPresent) {
      mainLog.warn(`[meetings] corrupt store backup present in ${meetingsDir}; skipping orphan sweep until it is resolved`)
      return
    }
    const knownPaths = new Set<string>()
    const knownIds = new Set<string>()
    for (const record of state.records.values()) {
      if (record.recording?.path) knownPaths.add(record.recording.path)
      knownIds.add(safeFileId(record.id))
    }

    const recordingsDir = join(meetingsDir, 'recordings')
    if (existsSync(recordingsDir)) {
      let removed = 0
      let entries: string[]
      try {
        entries = readdirSync(recordingsDir)
      } catch (error) {
        mainLog.warn(`[meetings] could not read recordings dir for orphan cleanup: ${error instanceof Error ? error.message : String(error)}`)
        entries = []
      }
      for (const entry of entries) {
        // Skip atomic-write staging files (see `atomicWriteTextFileSync`) and any
        // other non-.webm artifact that may have been written to this folder.
        if (!entry.endsWith('.webm')) continue
        const filePath = join(recordingsDir, entry)
        if (knownPaths.has(filePath)) continue
        try {
          unlinkSync(filePath)
          removed += 1
        } catch (error) {
          mainLog.warn(`[meetings] failed to remove orphan recording ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (removed > 0) {
        mainLog.info(`[meetings] orphan recording cleanup removed=${removed} dir=${recordingsDir}`)
      }
    }

    // Sweep generated video-analysis evidence dirs with no owning record. These
    // can leak when a meeting is deleted mid-analysis: deleteMeeting's rmSync
    // removes the dir, then the in-flight extractVideoEvidence mkdirSync recreates
    // it after the record is gone. Runs on the same once-per-workspace startup
    // pass as the .webm sweep, so it cannot race a live recording.
    const videoAnalysisRoot = join(meetingsDir, 'video-analysis')
    if (existsSync(videoAnalysisRoot)) {
      let removed = 0
      let entries: string[]
      try {
        entries = readdirSync(videoAnalysisRoot)
      } catch (error) {
        mainLog.warn(`[meetings] could not read video-analysis dir for orphan cleanup: ${error instanceof Error ? error.message : String(error)}`)
        entries = []
      }
      for (const entry of entries) {
        if (knownIds.has(entry)) continue
        try {
          rmSync(join(videoAnalysisRoot, entry), { recursive: true, force: true })
          removed += 1
        } catch (error) {
          mainLog.warn(`[meetings] failed to remove orphan video-analysis dir ${entry}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (removed > 0) {
        mainLog.info(`[meetings] orphan video-analysis cleanup removed=${removed} dir=${videoAnalysisRoot}`)
      }
    }
  }

  private persist(state: WorkspaceMeetingState): void {
    const dir = dirname(state.storePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: PersistedMeetingsStore = {
      version: 1,
      meetings: [...state.records.values()],
    }
    atomicWriteTextFileSync(state.storePath, JSON.stringify(payload, null, 2))
  }

  private getWorkspaceState(workspaceRootPath: string): WorkspaceMeetingState {
    const stateKey = this.storePathOverride ?? workspaceRootPath
    const existing = this.workspaceStates.get(stateKey)
    if (existing) return existing

    const meetingsDir = this.storePathOverride ? dirname(this.storePathOverride) : getWorkspaceMeetingsPath(workspaceRootPath)
    const state: WorkspaceMeetingState = {
      records: new Map(),
      transcripts: new Map(),
      loaded: false,
      corruptDetected: false,
      storePath: this.storePathOverride ?? join(meetingsDir, 'meetings.json'),
      configPath: join(meetingsDir, 'config.json'),
      transcriptsDir: join(meetingsDir, 'transcripts'),
      summariesDir: join(meetingsDir, 'summaries'),
    }
    this.workspaceStates.set(stateKey, state)
    return state
  }

  private loadTranscript(state: WorkspaceMeetingState, meetingId: string): MeetingTranscriptResult | null {
    const filePath = this.getTranscriptPath(state, meetingId)
    if (!existsSync(filePath)) return null
    try {
      const parsed = readJsonFileSync<MeetingTranscriptResult>(filePath)
      if (parsed.meetingId !== meetingId || !Array.isArray(parsed.transcript)) return null
      return parsed
    } catch {
      return null
    }
  }

  private persistTranscript(state: WorkspaceMeetingState, transcript: MeetingTranscriptResult): void {
    if (!existsSync(state.transcriptsDir)) mkdirSync(state.transcriptsDir, { recursive: true })
    atomicWriteTextFileSync(this.getTranscriptPath(state, transcript.meetingId), JSON.stringify(transcript, null, 2))
    if (transcript.summaryMarkdown) {
      this.persistSummaryMarkdown(state, {
        id: transcript.meetingId,
        summaryMarkdown: transcript.summaryMarkdown,
      })
    } else {
      this.deleteSummaryMarkdown(state, transcript.meetingId)
    }
  }

  private persistSummaryMarkdown(
    state: WorkspaceMeetingState,
    record: Pick<MeetingRecord, 'id' | 'summaryMarkdown'>,
  ): void {
    if (!record.summaryMarkdown) return
    if (!existsSync(state.summariesDir)) mkdirSync(state.summariesDir, { recursive: true })
    atomicWriteTextFileSync(join(state.summariesDir, `${safeFileId(record.id)}.md`), record.summaryMarkdown)
  }

  private deleteSummaryMarkdown(state: WorkspaceMeetingState, meetingId: string): void {
    const summaryPath = join(state.summariesDir, `${safeFileId(meetingId)}.md`)
    try {
      if (existsSync(summaryPath)) unlinkSync(summaryPath)
    } catch {
      // Best-effort cleanup only; stale summaries should not break meeting updates.
    }
  }

  private getTranscriptPath(state: WorkspaceMeetingState, meetingId: string): string {
    return join(state.transcriptsDir, `${safeFileId(meetingId)}.json`)
  }

  private getVideoAnalysisDir(state: WorkspaceMeetingState, meetingId: string): string {
    return join(dirname(state.storePath), 'video-analysis', safeFileId(meetingId))
  }

  private loadTranscriptionConfig(state: WorkspaceMeetingState): Omit<MeetingTranscriptionConfig, 'hasApiKey'> {
    if (!existsSync(state.configPath)) return DEFAULT_MEETING_TRANSCRIPTION_CONFIG
    try {
      const parsed = readJsonFileSync<PersistedMeetingTranscriptionConfig>(state.configPath)
      const provider = normalizeTranscriptionProvider(parsed.transcription?.provider)
      return {
        provider,
        model: normalizeTranscriptionModel(parsed.transcription?.model, provider),
      }
    } catch {
      return DEFAULT_MEETING_TRANSCRIPTION_CONFIG
    }
  }

  private persistTranscriptionConfig(
    state: WorkspaceMeetingState,
    config: Omit<MeetingTranscriptionConfig, 'hasApiKey'>,
  ): void {
    const dir = dirname(state.configPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: PersistedMeetingTranscriptionConfig = {
      version: 1,
      transcription: {
        provider: config.provider,
        model: normalizeTranscriptionModel(config.model, config.provider),
      },
    }
    atomicWriteTextFileSync(state.configPath, JSON.stringify(payload, null, 2))
  }
}

export function normalizeGoogleMeetUrl(input: unknown): { url: string; code?: string } {
  const raw = String(input ?? '').trim()
  if (!raw) {
    throw new Error('Google Meet URL or code is required')
  }

  const normalizedCode = normalizeMeetCode(raw)
  if (normalizedCode) {
    return { url: `https://meet.google.com/${normalizedCode}`, code: normalizedCode }
  }

  let parsed: URL
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new Error(`Invalid Google Meet URL or code: ${raw}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!GOOGLE_MEET_HOSTS.has(hostname)) {
    throw new Error(`Only Google Meet URLs are supported: ${raw}`)
  }

  const pathCode = normalizeMeetCode(parsed.pathname.split('/').filter(Boolean)[0] ?? '')
  if (!pathCode) {
    throw new Error(`Google Meet URL must include a meeting code: ${raw}`)
  }

  const out = new URL(`https://meet.google.com/${pathCode}`)
  const authUser = parsed.searchParams.get('authuser')
  if (authUser) out.searchParams.set('authuser', authUser)
  return { url: out.toString(), code: pathCode }
}

function normalizeMeetCode(value: string): string | null {
  const cleaned = value.trim().toLowerCase()
  if (MEET_CODE_RE.test(cleaned)) return cleaned
  const compact = cleaned.replace(/[^a-z]/g, '')
  if (!COMPACT_MEET_CODE_RE.test(compact)) return null
  return `${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7)}`
}


function createTranscriptPlaceholder(record: MeetingRecord): MeetingTranscriptResult {
  const captureMode = record.captureMode ?? 'hermes'
  const message = captureMode === 'craft'
    ? t('meetings.placeholderCraftMessage')
    : t('meetings.placeholderHermesMessage')
  return {
    meetingId: record.id,
    status: 'placeholder',
    transcript: [],
    summaryMarkdown: record.summaryMarkdown ?? createMeetingSummaryMarkdown({
      title: record.title,
      url: record.url,
      captureMode,
      transcriptionProvider: record.transcriptionProvider,
      transcriptionModel: record.transcriptionModel,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    }),
    message,
    updatedAt: Date.now(),
  }
}

/**
 * Main-process i18n access. `setupI18n()` runs at app startup (main/index.ts)
 * and the renderer syncs language changes via the `i18n:changeLanguage` IPC;
 * the lazy init only matters for tests that import this module directly.
 */
function t(key: string, options?: Record<string, unknown>): string {
  if (!i18n.isInitialized) setupI18n()
  return String(i18n.t(key, options))
}

function createMeetingSummaryMarkdown(input: {
  title?: string
  url: string
  captureMode: 'hermes' | 'craft'
  transcriptionProvider?: MeetingTranscriptionProvider
  transcriptionModel?: string
  status: MeetingStatus
  startedAt: number
  endedAt?: number
  summaryBody?: string
}): string {
  const title = input.title?.trim() || 'Google Meet'
  const owner = input.captureMode === 'craft' ? t('meetings.captureModeCraft') : t('meetings.captureModeHermes')
  const statusLabel = formatMeetingStatus(input.status)
  const dateLocale = i18n.resolvedLanguage
  const lines = [
    `# ${title}`,
    '',
    `- ${t('meetings.summaryDocOrigin')}: ${owner}`,
    `- ${t('meetings.summaryDocStatus')}: ${statusLabel}`,
    `- ${t('meetings.summaryDocLink')}: ${input.url}`,
    `- ${t('meetings.summaryDocStart')}: ${new Date(input.startedAt).toLocaleString(dateLocale)}`,
  ]
  if (input.transcriptionProvider && input.transcriptionModel) {
    lines.push(`- ${t('meetings.configTitle')}: ${formatTranscriptionProvider(input.transcriptionProvider)} / ${input.transcriptionModel}`)
  }
  if (input.endedAt) {
    lines.push(`- ${t('meetings.summaryDocEnd')}: ${new Date(input.endedAt).toLocaleString(dateLocale)}`)
  }
  lines.push('', `## ${t('meetings.summary')}`, '')
  if (input.summaryBody) {
    lines.push(input.summaryBody)
  } else if (input.captureMode === 'craft') {
    lines.push(t('meetings.summaryDocBodyDefaultCraft'))
  } else {
    lines.push(t('meetings.summaryDocBodyDefaultHermes'))
  }
  return lines.join('\n')
}

function formatMeetingStatus(status: MeetingStatus): string {
  switch (status) {
    case 'starting':
      return t('meetings.statusStarting')
    case 'running':
      return t('meetings.statusRunning')
    case 'stopped':
      return t('meetings.statusStopped')
    case 'error':
      return t('meetings.statusError')
    default:
      return status
  }
}

function isTranscriptionProvider(value: unknown): value is MeetingTranscriptionProvider {
  return value === 'deepgram'
}

function normalizeTranscriptionProvider(
  value: unknown,
  options: { strict?: boolean } = {},
): MeetingTranscriptionProvider {
  if (value === undefined || value === null) {
    return DEFAULT_TRANSCRIPTION_PROVIDER
  }
  if (isTranscriptionProvider(value)) return value
  if (options.strict) {
    throw new Error(`Unsupported transcription provider: ${String(value)}`)
  }
  return DEFAULT_TRANSCRIPTION_PROVIDER
}

function normalizeTranscriptionModel(value: unknown, provider: MeetingTranscriptionProvider): string {
  const model = typeof value === 'string' ? value.trim() : ''
  return model || DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER[provider]
}

function formatTranscriptionProvider(provider: MeetingTranscriptionProvider): string {
  return 'Deepgram'
}

function getTranscriptionCredentialId(workspaceId: string, provider: MeetingTranscriptionProvider): CredentialId {
  return {
    type: 'meeting_transcription_api_key',
    workspaceId,
    name: provider,
  }
}

function safeFileId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function atomicWriteTextFileSync(filePath: string, data: string, mode?: number): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  try {
    if (mode === undefined) {
      writeFileSync(tmp, data, 'utf8')
    } else {
      writeFileSync(tmp, data, { encoding: 'utf8', mode })
    }
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Best-effort cleanup only.
    }
    throw error
  }
}

function sanitizeRecord(record: MeetingRecord): MeetingRecord | null {
  if (!record || typeof record.id !== 'string' || typeof record.url !== 'string' || typeof record.browserInstanceId !== 'string') {
    return null
  }
  const status: MeetingStatus = ['starting', 'running', 'stopped', 'error'].includes(record.status)
    ? record.status
    : 'stopped'
  let transcriptionProvider: MeetingTranscriptionProvider | undefined
  if (record.transcriptionProvider != null) {
    try {
      transcriptionProvider = normalizeTranscriptionProvider(record.transcriptionProvider, { strict: true })
    } catch {
      transcriptionProvider = undefined
    }
  }
  return {
    ...record,
    provider: 'google-meet',
    captureMode: record.captureMode === 'craft' ? 'craft' : 'hermes',
    status: status === 'running' || status === 'starting' ? 'stopped' : status,
    startedAt: Number(record.startedAt) || Date.now(),
    updatedAt: Number(record.updatedAt) || Date.now(),
    endedAt: record.endedAt,
    summaryMarkdown: typeof record.summaryMarkdown === 'string' ? record.summaryMarkdown : undefined,
    transcriptionProvider,
    transcriptionModel: transcriptionProvider
      ? normalizeTranscriptionModel(record.transcriptionModel, transcriptionProvider)
      : undefined,
    ownsBrowserInstance: record.ownsBrowserInstance === true ? true : undefined,
    summarizeOnEnd: record.summarizeOnEnd === true ? true : undefined,
    followUpOnEnd: record.followUpOnEnd === true ? true : undefined,
    isArchived: record.isArchived === true ? true : undefined,
    archivedAt: typeof record.archivedAt === 'number' ? record.archivedAt : undefined,
    recording: record.recording && typeof record.recording.path === 'string' ? record.recording : undefined,
  }
}
