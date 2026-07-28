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
import { getWorkspaceMeetingsPath, loadWorkspaceConfig } from '@craft-agent/shared/workspaces'

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
/** Cadência do health check que reconcilia a reunião com o estado real do bot. */
const HERMES_HEALTH_CHECK_MS = 30_000
/**
 * Cadência do poll incremental do transcript enquanto a reunião roda (U2). Um
 * crash perde no máximo uma janela dessas; finalizar apenas sela o tail.
 */
const HERMES_TRANSCRIPT_POLL_MS = 10_000
/**
 * Deadline duro para selar reuniões ativas durante o quit (U3). O quit continua
 * quando ele expira: a persistência incremental já limitou a perda.
 */
export const MEETINGS_SHUTDOWN_DEADLINE_MS = 20_000

/**
 * Razões `ok:false` do plugin que provam que o bot já saiu do call — tanto num
 * `status` quanto num `stop`. Só elas são evidência: qualquer outro `ok:false` é
 * falha de transporte/timeout do próprio exec, e tratá-la como término
 * encerraria uma reunião viva sem evidência nenhuma.
 */
const HERMES_BOT_GONE_REASONS = new Set(['no active meeting'])

/**
 * Resultado de uma finalização. `failed` é falha transitória (o record segue
 * ativo e a reconciliação é rearmada); `skipped` é reunião já terminal, craft ou
 * inexistente.
 */
type HermesFinalizeOutcome = 'sealed' | 'failed' | 'skipped'

export type MeetingsShutdownOutcome = 'idle' | 'sealed' | 'failed' | 'deadline'

/**
 * Razão terminal gravada no record. Interna ao main process nesta fase — expor
 * no DTO/UI é F2 (task 2.3) — mas persistida no store para que nenhum
 * encerramento fique sem causa registrada.
 */
export type MeetingEndReason = 'user_stop' | 'pane_closed' | 'bot_exited' | 'app_quit' | 'deleted'

const MEETING_END_REASONS: readonly MeetingEndReason[] = ['user_stop', 'pane_closed', 'bot_exited', 'app_quit', 'deleted']

type MeetingRecordWithEndReason = MeetingRecord & { endReason?: MeetingEndReason }

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
  meetings: MeetingRecordWithEndReason[]
}

interface PersistedMeetingTranscriptionConfig {
  version?: number
  transcription?: {
    provider?: MeetingTranscriptionProvider
    model?: string
  }
}

interface WorkspaceMeetingState {
  records: Map<string, MeetingRecordWithEndReason>
  transcripts: Map<string, MeetingTranscriptResult>
  loaded: boolean
  corruptDetected: boolean
  storePath: string
  configPath: string
  transcriptsDir: string
  summariesDir: string
  workspaceRootPath: string
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

/**
 * Serviços vivos, referenciados fracamente para que o hook de quit alcance o
 * singleton do app sem prender instâncias efêmeras (os testes criam dezenas).
 * Uma captura ativa é alcançável pelos próprios timers, então ela nunca é
 * coletada enquanto a reunião roda.
 */
const liveMeetingServices = new Set<WeakRef<MeetingService>>()

function collectLiveMeetingServices(): MeetingService[] {
  const services: MeetingService[] = []
  for (const ref of [...liveMeetingServices]) {
    const service = ref.deref()
    if (service) services.push(service)
    else liveMeetingServices.delete(ref)
  }
  return services
}

/**
 * Sela toda captura Hermes ativa antes do app sair (U3). Bounded: devolve
 * `deadline` e deixa o quit seguir quando o plugin não responde no prazo, e
 * `failed` quando o seal em si falhou — o quit segue, mas sem alegar seal.
 */
export async function shutdownMeetingCaptures(
  deadlineMs = MEETINGS_SHUTDOWN_DEADLINE_MS,
): Promise<MeetingsShutdownOutcome> {
  const outcomes = await Promise.all(collectLiveMeetingServices().map((service) => service.shutdown(deadlineMs)))
  if (outcomes.includes('deadline')) return 'deadline'
  if (outcomes.includes('failed')) return 'failed'
  if (outcomes.includes('sealed')) return 'sealed'
  return 'idle'
}

/**
 * `app.relaunch()` + `app.exit(0)` não emitem `before-quit`, então o hook de
 * quit nunca roda nesse caminho e uma captura ativa ficaria sem seal. Sela
 * primeiro, com o mesmo deadline bounded do quit, e só então relança/encerra.
 */
export async function relaunchAfterSealingCaptures(
  hooks: { relaunch: () => void; exit: () => void },
  deadlineMs = MEETINGS_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const outcome = await shutdownMeetingCaptures(deadlineMs)
  if (outcome !== 'idle') {
    mainLog.info(`[meetings] relaunch shutdown outcome=${outcome}`)
  }
  hooks.relaunch()
  hooks.exit()
}

export class MeetingService {
  private readonly workspaceStates = new Map<string, WorkspaceMeetingState>()
  private readonly healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly transcriptPollTimers = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * Finalizações em voo por meetingId. Esta entrada é o mutex do bot singleton:
   * sinais terminais concorrentes (ou repetidos, já que `list()` chama refresh a
   * cada poll da UI) compartilham a mesma promise em vez de buscar transcript e
   * parar o bot de novo, e `start()` recusa enquanto ela existir.
   *
   * Ela é removida no settle, então uma falha transitória não envenena o
   * meetingId: os timers são rearmados e o próximo sinal tenta de novo. Depois de
   * um seal bem-sucedido é o status terminal do record que impede uma segunda
   * finalização.
   */
  private readonly hermesFinalizations = new Map<string, Promise<HermesFinalizeOutcome>>()
  /**
   * Intenção de purge por meetingId: o delete já foi aceito e a reunião sai da
   * API na hora (o usuário mandou apagar), mas o record continua no store até o
   * seal terminar `transcript → persist → stop`. Como a intenção mora aqui e não
   * num callback, um delete que chega sobre uma finalização já em voo continua
   * sendo honrado por ela. Consumida sempre no settle — um seal falho devolve a
   * reunião à API em vez de deixá-la oculta para sempre.
   */
  private readonly pendingDeletions = new Set<string>()
  /**
   * Deadline for the Hermes bot to reach the lobby/call before start() fails.
   * Mutable so tests can shrink the real-time wait in `waitForHermesMeetBotReady`.
   */
  private botReadyTimeoutMs = 20_000

  constructor(
    private readonly browserPaneManager: BrowserPaneManager,
    private readonly storePathOverride?: string,
    private readonly videoAnalysisGenerator: MeetingVideoAnalysisGenerator = generateMeetingVideoAnalysisMarkdown,
  ) {
    liveMeetingServices.add(new WeakRef(this))
  }

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
      // O bot singleton continua ocupado enquanto qualquer finalização está em
      // voo: aceitar um Start aqui deixaria o finalizer anterior parar o bot novo
      // (e capturar o transcript dele) no meio da reunião seguinte.
      const finalizing = this.findFinalizingHermesMeeting()
      if (finalizing) {
        throw new Error(t('meetings.hermesBotBusy', { url: finalizing }))
      }
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
      ? this.browserPaneManager.getLiveInstance(requestedBrowserInstanceId)
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
        this.startTranscriptPoll(state, id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.error(`[meetings] start failed id=${id} url=${normalized.url}: ${message}`)
      if (usesHermesBot && botStarted) {
        // Rollback de um start que falhou, não término de captura: o bot nunca
        // chegou ao call, então não há transcript a buscar e o record termina
        // como `error` logo abaixo. É o único `stop` fora da finalização.
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

  /**
   * Rótulo da finalização em voo, se houver. O record normalmente ainda existe;
   * durante a janela de cleanup de um delete ele já foi purgado, então cai no
   * meetingId.
   */
  private findFinalizingHermesMeeting(): string | null {
    for (const meetingId of this.hermesFinalizations.keys()) {
      for (const state of this.workspaceStates.values()) {
        const record = state.records.get(meetingId)
        if (record) return record.url
      }
      return meetingId
    }
    return null
  }

  list(workspaceRootPath: string, options?: { includeArchived?: boolean }): MeetingRecord[] {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    const records = [...state.records.values()]
      .filter((record) => !this.pendingDeletions.has(record.id))
      .sort((a, b) => b.startedAt - a.startedAt)
    if (options?.includeArchived) return records
    return records.filter((r) => !r.isArchived)
  }

  status(workspaceRootPath: string, id: string): MeetingRecord | null {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    if (this.pendingDeletions.has(id)) return null
    return state.records.get(id) ?? null
  }

  stop(workspaceId: string, workspaceRootPath: string, id: string): MeetingRecord {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = this.getRequired(state, id)
    if (record.status === 'stopped') {
      return record
    }

    if (record.captureMode !== 'craft') {
      // Stop explícito não anuncia término: quem grava status/endedAt/endReason é
      // a finalização, depois de `transcript → persist → stop`. Publicar `stopped`
      // aqui liberaria o bot singleton antes do seal, e um Start imediato mataria
      // o finalizer da reunião anterior.
      void this.finalizeHermesCapture({
        workspaceId,
        workspaceRootPath,
        meetingId: id,
        reason: 'user_stop',
      })
      if (record.ownsBrowserInstance) {
        try { this.browserPaneManager.destroyInstance(record.browserInstanceId) } catch { /* pane já fechado */ }
      }
      return this.getRequired(state, id)
    }

    this.stopHealthCheck(id)
    try {
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

  /**
   * Sela as capturas Hermes ativas antes do app sair (U3).
   *
   * - sem reunião ativa: nada é armado e o quit não paga atraso (`idle`);
   * - com reunião ativa: corre a finalização contra um watchdog `unref`'d, então
   *   um plugin travado devolve `deadline` e o quit segue. O que o poll
   *   incremental já escreveu permanece no disco.
   */
  async shutdown(deadlineMs = MEETINGS_SHUTDOWN_DEADLINE_MS): Promise<MeetingsShutdownOutcome> {
    const active: Array<{ workspaceRootPath: string; meetingId: string }> = []
    for (const state of this.workspaceStates.values()) {
      for (const record of state.records.values()) {
        if (record.captureMode !== 'craft' && ['starting', 'running'].includes(record.status)) {
          active.push({ workspaceRootPath: state.workspaceRootPath, meetingId: record.id })
        }
      }
    }

    if (active.length === 0) {
      this.disposeTimers()
      return 'idle'
    }

    const sealed = Promise.all(active.map(({ workspaceRootPath, meetingId }) => this.finalizeHermesCapture({
      workspaceRootPath,
      meetingId,
      reason: 'app_quit',
    }))).then((outcomes) => (outcomes.includes('failed') ? 'failed' as const : 'sealed' as const))

    const { promise: expired, resolve: expire } = Promise.withResolvers<'deadline'>()
    const watchdog = setTimeout(() => expire('deadline'), deadlineMs)
    watchdog.unref?.()
    try {
      const outcome = await Promise.race([sealed, expired])
      if (outcome === 'deadline') {
        mainLog.warn(`[meetings] shutdown deadline of ${deadlineMs}ms hit with ${active.length} active capture(s); quitting anyway`)
      } else if (outcome === 'failed') {
        mainLog.error(`[meetings] shutdown could not seal ${active.length} active capture(s); quitting anyway`)
      }
      return outcome
    } finally {
      clearTimeout(watchdog)
      this.disposeTimers()
    }
  }

  private disposeTimers(): void {
    for (const meetingId of [...this.healthCheckTimers.keys()]) this.stopHealthCheck(meetingId)
    for (const meetingId of [...this.transcriptPollTimers.keys()]) this.stopTranscriptPoll(meetingId)
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
    if (!record || this.pendingDeletions.has(id)) return
    const live = ['starting', 'running'].includes(record.status)

    if (live && record.captureMode !== 'craft') {
      // Delete-while-running passa pelo mesmo sink durável dos outros términos:
      // `transcript → persist → stop` primeiro, cleanup depois. A intenção de
      // purge vive em `pendingDeletions`, não num callback: assim ela sobrevive a
      // um sinal terminal que já estava em voo (Stop/pane/health), quem sela é
      // quem purga — exatamente uma vez — e um seal falho não apaga nada.
      this.pendingDeletions.add(id)
      void this.finalizeHermesCapture({
        workspaceRootPath,
        meetingId: id,
        reason: 'deleted',
      })
      if (record.ownsBrowserInstance) {
        try { this.browserPaneManager.destroyInstance(record.browserInstanceId) } catch { /* pane já fechado */ }
      }
      return
    }

    if (live) {
      this.stopHealthCheck(id)
      if (record.ownsBrowserInstance) {
        try { this.browserPaneManager.destroyInstance(record.browserInstanceId) } catch { /* pane já fechado */ }
      }
    }
    this.purgeMeeting(state, id)
  }

  /**
   * Remove record, transcript, summary, recording e evidência gerada do disco.
   *
   * A escrita do store é o ponto de virada: enquanto ela não confirma, nada foi
   * apagado de verdade. Uma falha ali restaura record e transcript exatamente
   * como estavam e relança, porque uma memória vazia sobre um disco intacto
   * faria o delete parecer concluído e a reunião reapareceria no próximo boot —
   * agora sem transcript, já que os arquivos teriam sido removidos por um store
   * que nunca chegou ao disco.
   */
  private purgeMeeting(state: WorkspaceMeetingState, id: string): void {
    const record = state.records.get(id)
    const transcript = state.transcripts.get(id)
    state.records.delete(id)
    state.transcripts.delete(id)
    try {
      this.persist(state)
    } catch (error) {
      if (record) state.records.set(id, record)
      if (transcript) state.transcripts.set(id, transcript)
      throw error
    }
    const transcriptPath = join(state.transcriptsDir, `${safeFileId(id)}.json`)
    try { if (existsSync(transcriptPath)) unlinkSync(transcriptPath) } catch {}
    const summaryPath = join(state.summariesDir, `${safeFileId(id)}.md`)
    try { if (existsSync(summaryPath)) unlinkSync(summaryPath) } catch {}
    if (record?.recording?.path) {
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
   * Único sink terminal da captura Hermes (F1/U1). Stop explícito, pane fechado,
   * bot morto, delete-while-running e quit passam todos por aqui, e a ordem é
   * sempre a mesma: buscar o transcript → persistir → parar o bot → gravar
   * status/reason. Inverter isso perde o único estado que o bot mantém, porque
   * `pm.stop` limpa o ponteiro do processo ativo.
   *
   * Idempotente por meetingId enquanto está em voo: sinais terminais concorrentes
   * compartilham a mesma promise, então o transcript é buscado uma vez e o bot
   * para uma vez.
   */
  private finalizeHermesCapture(args: {
    workspaceRootPath: string
    meetingId: string
    reason: MeetingEndReason
    workspaceId?: string
    botError?: string
  }): Promise<HermesFinalizeOutcome> {
    const inflight = this.hermesFinalizations.get(args.meetingId)
    if (inflight) return inflight

    // Os timers param antes de qualquer await: um poll em voo não pode reescrever
    // um transcript que o delete acabou de remover.
    this.stopHealthCheck(args.meetingId)
    this.stopTranscriptPoll(args.meetingId)

    const run = this.runFinalizationLifecycle(args)
    this.hermesFinalizations.set(args.meetingId, run)
    return run
  }

  /**
   * Janela in-flight completa de um sinal terminal: seal, cleanup dependente do
   * seal e, em caso de falha, rearme da reconciliação. A entrada só sai da tabela
   * no fim, então o bot singleton permanece ocupado durante tudo isso, e o trecho
   * pós-seal é síncrono — nenhum sinal novo se intercala entre o cleanup e a
   * liberação do mutex.
   */
  private async runFinalizationLifecycle(args: {
    workspaceRootPath: string
    meetingId: string
    reason: MeetingEndReason
    workspaceId?: string
    botError?: string
  }): Promise<HermesFinalizeOutcome> {
    let outcome: HermesFinalizeOutcome
    try {
      outcome = await this.runHermesFinalization(args)
    } catch (error) {
      mainLog.error(
        `[meetings] finalize (${args.reason}) failed for ${args.meetingId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      outcome = 'failed'
    }

    try {
      this.settlePendingDeletion(args.workspaceRootPath, args.meetingId, outcome)
    } catch (error) {
      mainLog.error(
        `[meetings] post-finalization cleanup failed for ${args.meetingId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (outcome === 'failed') this.rearmHermesReconciliation(args.workspaceRootPath, args.meetingId)
    this.hermesFinalizations.delete(args.meetingId)
    return outcome
  }

  /**
   * Resolve a intenção de delete depois do seal, ainda dentro da janela que
   * mantém o bot ocupado. A intenção é sempre consumida, então uma falha nunca
   * deixa o record oculto para sempre; mas só um seal que não falhou purga:
   * apagar record/transcript por cima de uma falha transitória destruiria
   * exatamente o que o retry ainda pode preservar.
   */
  private settlePendingDeletion(
    workspaceRootPath: string,
    meetingId: string,
    outcome: HermesFinalizeOutcome,
  ): void {
    if (!this.pendingDeletions.delete(meetingId)) return
    if (outcome === 'failed') {
      mainLog.warn(`[meetings] delete of ${meetingId} not applied: the seal failed, so the record stays active for a retry`)
      return
    }
    this.purgeMeeting(this.getWorkspaceState(workspaceRootPath), meetingId)
  }

  /**
   * Depois de uma falha transitória de seal, devolve a reunião ainda ativa à
   * reconciliação: o poll volta a levar transcript ao disco e o health check
   * volta a poder disparar o próximo sinal terminal. Sem isso um ENOSPC
   * momentâneo deixaria a reunião `running` para sempre, sem timers e sem retry.
   */
  private rearmHermesReconciliation(workspaceRootPath: string, meetingId: string): void {
    const state = this.getWorkspaceState(workspaceRootPath)
    const record = state.records.get(meetingId)
    if (!record || record.captureMode === 'craft') return
    if (!['starting', 'running'].includes(record.status)) return
    this.startHealthCheck(state, meetingId)
    this.startTranscriptPoll(state, meetingId)
    mainLog.warn(`[meetings] rearmed reconciliation for ${meetingId} after a failed seal`)
  }

  private async runHermesFinalization(args: {
    workspaceRootPath: string
    meetingId: string
    reason: MeetingEndReason
    workspaceId?: string
    botError?: string
  }): Promise<HermesFinalizeOutcome> {
    const { meetingId, reason } = args
    const state = this.getWorkspaceState(args.workspaceRootPath)
    const record = state.records.get(meetingId)
    if (!record || record.captureMode === 'craft') return 'skipped'
    // Record já terminal foi selado por outro sinal: não busque transcript nem
    // pare o bot de novo — esse `stop` mataria a captura seguinte.
    if (!['starting', 'running'].includes(record.status)) return 'skipped'

    const fetched = await this.fetchHermesTranscriptLines()
    const transcript = this.persistHermesTranscript(state, meetingId, fetched.lines, { seal: true })

    // Nada terminal é gravado sem prova de que o bot saiu do call: um `stopped`
    // por cima de um bot ainda no Meet liberaria o singleton e o próximo Start
    // reusaria um bot ocupado. O transcript já está no disco, então o retry
    // apenas re-sela o tail.
    const stopped = await this.confirmHermesBotStopped()
    if (!stopped.confirmed) {
      mainLog.error(`[meetings] bot stop not confirmed for ${meetingId}: ${stopped.error ?? 'unknown error'}`)
      return 'failed'
    }

    const current = state.records.get(meetingId)
    if (!current) return 'sealed'
    // Selado quando há linhas no disco ou o bot respondeu; `error` só quando o
    // término veio de uma falha e nada pôde ser preservado.
    const sealed = transcript.transcript.length > 0 || fetched.ok
    const status: MeetingStatus = sealed ? 'stopped' : 'error'
    this.updateRecord(state, meetingId, {
      status,
      endedAt: current.endedAt ?? Date.now(),
      endReason: reason,
      error: status === 'error'
        ? (args.botError || fetched.error || t('meetings.hermesTranscriptEmptyMessage'))
        : undefined,
      summaryMarkdown: transcript.summaryMarkdown,
    })
    mainLog.info(`[meetings] finalized ${meetingId} reason=${reason} status=${status} lines=${transcript.transcript.length}`)

    // Um delete não deixa record para receber summary: o cleanup vem logo atrás.
    if (reason !== 'deleted' && (current.summarizeOnEnd || current.followUpOnEnd) && transcript.transcript.length > 0) {
      const workspaceId = args.workspaceId ?? this.resolveWorkspaceId(args.workspaceRootPath)
      // Deliberadamente fora da janela in-flight: o resumo é opcional e lento, e
      // aguardá-lo aqui manteria o bot singleton ocupado (e atrasaria
      // shutdown/relaunch) com a captura já selada. O erro é logado, nunca solto.
      void this.generateAgentSummary(workspaceId, args.workspaceRootPath, meetingId, transcript.transcript)
        .catch((error) => {
          mainLog.error(
            `[meetings] agent summary failed for ${meetingId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }
    return 'sealed'
  }

  private async fetchHermesTranscriptLines(): Promise<{ ok: boolean; lines: string[]; error?: string }> {
    try {
      const res = await this.runHermesMeetPlugin('transcript')
      const rawLines = res.lines
      if (res.ok && Array.isArray(rawLines)) {
        return {
          ok: true,
          lines: rawLines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0),
        }
      }
      return { ok: false, lines: [], error: typeof res.error === 'string' ? res.error : undefined }
    } catch (error) {
      return { ok: false, lines: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Persiste o transcript Hermes capturado até agora. Chamado a cada tick do
   * poll (U2) e uma última vez ao selar, com duas garantias:
   *
   * - nunca encurta o que já está no disco, então um fetch que falhou não apaga
   *   as linhas que polls anteriores já preservaram;
   * - pula a escrita quando nada mudou, para não reescrever conteúdo idêntico.
   *
   * Usa `ready` em vez de `capturing` durante a reunião de propósito:
   * `recoverInterruptedTranscriptions` rebaixa transcripts `capturing` sem
   * recording em disco, o que apagaria justamente o que o poll salvou.
   */
  private persistHermesTranscript(
    state: WorkspaceMeetingState,
    meetingId: string,
    lines: string[],
    options: { seal: boolean },
  ): MeetingTranscriptResult {
    const record = state.records.get(meetingId)
    const existing = state.transcripts.get(meetingId) ?? this.loadTranscript(state, meetingId) ?? undefined
    const existingSegments = existing?.transcript ?? []
    if (!record) return existing ?? { meetingId, status: 'unavailable', transcript: [], updatedAt: Date.now() }

    const texts = lines.length >= existingSegments.length ? lines : existingSegments.map((segment) => segment.text)
    const unchanged = texts.length === existingSegments.length
      && texts.every((text, index) => existingSegments[index]?.text === text)

    const now = Date.now()
    const segments: MeetingTranscriptSegment[] = texts.map((text, index) => {
      const previous = existingSegments[index]
      if (previous?.text === text) return previous
      return {
        id: `${meetingId}-${index}`,
        speaker: /^([^:]{1,60}):\s+(.*)$/.exec(text)?.[1],
        text,
        timestamp: now,
      }
    })

    const status: MeetingTranscriptResult['status'] = segments.length > 0
      ? 'ready'
      : (options.seal ? 'unavailable' : 'placeholder')
    if (unchanged && existing && existing.status === status) return existing

    const message = segments.length > 0
      ? t('meetings.transcriptCompletedMessage', { count: segments.length })
      : t('meetings.hermesTranscriptEmptyMessage')
    const summaryMarkdown = createMeetingSummaryMarkdown({
      title: record.title,
      url: record.url,
      captureMode: 'hermes',
      transcriptionProvider: record.transcriptionProvider,
      transcriptionModel: record.transcriptionModel,
      status: options.seal ? 'stopped' : 'running',
      startedAt: record.startedAt,
      endedAt: options.seal ? (record.endedAt ?? now) : undefined,
      summaryBody: message,
    })
    const transcript: MeetingTranscriptResult = {
      meetingId,
      status,
      transcript: segments,
      summaryMarkdown,
      message,
      updatedAt: now,
    }
    state.transcripts.set(meetingId, transcript)
    this.persistTranscript(state, transcript)
    return transcript
  }

  /**
   * Workspace id para caminhos terminais sem contexto de RPC (pane fechado,
   * health check, quit). Melhor esforço: só o summary por agente depende dele.
   */
  private resolveWorkspaceId(workspaceRootPath: string): string {
    try {
      return loadWorkspaceConfig(workspaceRootPath)?.id ?? ''
    } catch {
      return ''
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
    if (!record || this.pendingDeletions.has(id)) {
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
    const timer = setInterval(() => { void this.runHermesHealthCheck(state, meetingId) }, HERMES_HEALTH_CHECK_MS)
    timer.unref?.()
    this.healthCheckTimers.set(meetingId, timer)
  }

  /**
   * Um tick de reconciliação com o estado real do bot. Qualquer término detectado
   * aqui vai para o sink de finalização, então o transcript é buscado antes do
   * stop mesmo quando o pane continua aberto — o caso "preso em running" do audit.
   */
  private async runHermesHealthCheck(state: WorkspaceMeetingState, meetingId: string): Promise<void> {
    const record = state.records.get(meetingId)
    if (!record || !['running', 'starting'].includes(record.status) || record.captureMode !== 'hermes') {
      this.stopHealthCheck(meetingId)
      this.stopTranscriptPoll(meetingId)
      return
    }

    let status: HermesMeetPluginResult
    try {
      status = await this.runHermesMeetPlugin('status', {}, { timeoutMs: 5_000 })
    } catch (err) {
      mainLog.warn(`[meetings] health-check failed for ${meetingId}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const ended = this.classifyHermesBotStatus(status)
    if (!ended.ended) return
    mainLog.warn(`[meetings] health-check: bot ended for ${meetingId}: ${ended.error ?? 'no active meeting'}`)
    await this.finalizeHermesCapture({
      workspaceRootPath: state.workspaceRootPath,
      meetingId,
      reason: 'bot_exited',
      botError: ended.error,
    })
  }

  /**
   * Interpreta um `status` do plugin. `ok:false` só encerra a reunião quando a
   * razão prova que o bot foi embora (`no active meeting`, o único `ok:false` que
   * `pm.status()` produz); qualquer outra falha `ok:false` vem do exec — timeout,
   * runtime ausente, saída não parseável — e não é evidência de término, então o
   * próximo tick tenta de novo em vez de encerrar uma reunião viva.
   */
  private classifyHermesBotStatus(status: HermesMeetPluginResult): { ended: boolean; error?: string } {
    if (status.ok === false) {
      const reason = typeof status.reason === 'string' ? status.reason.trim() : ''
      return HERMES_BOT_GONE_REASONS.has(reason.toLowerCase())
        ? { ended: true, error: reason }
        : { ended: false }
    }
    if (status.exited || status.error || status.leaveReason || status.alive === false) {
      const error = typeof status.error === 'string' ? status.error : undefined
      const leaveReason = typeof status.leaveReason === 'string' ? status.leaveReason : undefined
      return { ended: true, error: error || leaveReason }
    }
    return { ended: false }
  }

  /**
   * Interpreta a resposta do `stop`. Só duas coisas liberam o caminho terminal:
   * `ok:true` (o plugin sinalizou o bot e limpou o ponteiro ativo) e o
   * `ok:false` + `reason: 'no active meeting'` que prova que já não havia bot.
   * Timeout, runtime ausente, saída não parseável e qualquer outro `ok:false`
   * são falha sem evidência: a captura não é selada e o retry decide depois.
   */
  private async confirmHermesBotStopped(): Promise<{ confirmed: boolean; error?: string }> {
    let result: HermesMeetPluginResult
    try {
      result = await this.runHermesMeetPlugin('stop')
    } catch (error) {
      return { confirmed: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok === true) return { confirmed: true }
    const reason = typeof result.reason === 'string' ? result.reason.trim() : ''
    if (HERMES_BOT_GONE_REASONS.has(reason.toLowerCase())) return { confirmed: true }
    return { confirmed: false, error: result.error || reason || 'the plugin returned no stop confirmation' }
  }

  private stopHealthCheck(meetingId: string): void {
    const timer = this.healthCheckTimers.get(meetingId)
    if (timer) {
      clearInterval(timer)
      this.healthCheckTimers.delete(meetingId)
    }
  }

  /**
   * Poll incremental do transcript enquanto a reunião roda (U2). Serializado: o
   * timer só dispara o próximo tick depois que o anterior assentou, então dois
   * fetches nunca competem pela mesma escrita.
   */
  private startTranscriptPoll(state: WorkspaceMeetingState, meetingId: string): void {
    if (this.transcriptPollTimers.has(meetingId)) return
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void this.pollHermesTranscript(state, meetingId).finally(() => { running = false })
    }, HERMES_TRANSCRIPT_POLL_MS)
    timer.unref?.()
    this.transcriptPollTimers.set(meetingId, timer)
  }

  private stopTranscriptPoll(meetingId: string): void {
    const timer = this.transcriptPollTimers.get(meetingId)
    if (timer) {
      clearInterval(timer)
      this.transcriptPollTimers.delete(meetingId)
    }
  }

  /**
   * Um tick do poll: leva ao disco o que o bot já transcreveu. Falha de um tick é
   * logada e ignorada — o próximo tick recupera, e finalizar sela o tail.
   */
  private async pollHermesTranscript(state: WorkspaceMeetingState, meetingId: string): Promise<void> {
    const record = state.records.get(meetingId)
    if (!record || record.status !== 'running' || record.captureMode !== 'hermes') {
      this.stopTranscriptPoll(meetingId)
      return
    }

    const fetched = await this.fetchHermesTranscriptLines()
    if (!fetched.ok) {
      mainLog.warn(`[meetings] transcript poll failed for ${meetingId}: ${fetched.error ?? 'unknown error'}`)
      return
    }
    // Um sinal terminal pode ter chegado durante o fetch; nesse caso a
    // finalização é dona da escrita.
    if (this.hermesFinalizations.has(meetingId) || !state.records.has(meetingId)) return
    this.persistHermesTranscript(state, meetingId, fetched.lines, { seal: false })
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

  private getRequired(state: WorkspaceMeetingState, id: string): MeetingRecordWithEndReason {
    const record = state.records.get(id)
    if (!record) {
      throw new Error(`Meeting not found: ${id}`)
    }
    return record
  }

  /**
   * Aplica a mudança em memória e no store. Só a escrita do store é
   * transacional: se ela falhar, o record anterior volta ao Map antes de
   * relançar, senão a memória seguiria adiante do disco — um status terminal
   * que nunca persistiu faria a reconciliação ignorar um record que o disco
   * ainda vê ativo, e o retry ficaria impossível.
   *
   * As escritas derivadas abaixo (summary/transcript) são deliberadamente
   * deixadas fora do rollback: elas acontecem depois do store já persistido, e
   * desfazer o record por causa delas descartaria uma escrita bem-sucedida.
   */
  private updateRecord(
    state: WorkspaceMeetingState,
    id: string,
    updates: Partial<MeetingRecordWithEndReason> & { summaryMarkdown?: string | null },
  ): void {
    const existing = this.getRequired(state, id)
    const next: MeetingRecordWithEndReason = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
      summaryMarkdown: hasOwn(updates, 'summaryMarkdown')
        ? (updates.summaryMarkdown || undefined)
        : existing.summaryMarkdown,
    }
    state.records.set(id, next)
    try {
      this.persist(state)
    } catch (error) {
      state.records.set(id, existing)
      throw error
    }
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

  /**
   * Reconcilia reuniões cujo pane já não existe. Para captura Hermes o status
   * terminal sai da finalização, que busca e persiste o transcript antes de
   * parar o bot; nenhum caminho daqui chama `stop` direto.
   */
  private refreshLiveStatuses(state: WorkspaceMeetingState): void {
    let changed = false
    for (const record of state.records.values()) {
      if (!['starting', 'running'].includes(record.status)) continue
      const instance = this.browserPaneManager.getLiveInstance(record.browserInstanceId)
      if (instance) continue
      if (record.captureMode !== 'craft') {
        void this.finalizeHermesCapture({
          workspaceRootPath: state.workspaceRootPath,
          meetingId: record.id,
          reason: 'pane_closed',
        })
        continue
      }
      state.records.set(record.id, {
        ...record,
        status: 'stopped',
        endedAt: record.endedAt ?? Date.now(),
        updatedAt: Date.now(),
      })
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
      workspaceRootPath,
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

function sanitizeRecord(record: MeetingRecordWithEndReason): MeetingRecordWithEndReason | null {
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
    // Um encerramento já registrado sobrevive ao reload; boot que rebaixa
    // running/starting para stopped não tem causa conhecida e fica sem reason.
    endReason: record.endReason && MEETING_END_REASONS.includes(record.endReason) ? record.endReason : undefined,
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
