import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { session } from 'electron'
import type {
  MeetingRecord,
  MeetingTranscriptionConfig,
  MeetingStartInput,
  MeetingStatus,
  MeetingTranscriptionProvider,
  MeetingTranscriptResult,
  SaveMeetingTranscriptionConfigInput,
} from '../../shared/types'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { getHermesRuntimePaths } from '../handlers/hermes-runtime'
import { getProfilePartition } from '../browser-profile-resolver'
import { mainLog } from '../logger'
import { getCredentialManager, type CredentialId } from '@craft-agent/shared/credentials'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'

const execFileAsync = promisify(execFile)

const GOOGLE_MEET_HOSTS = new Set(['meet.google.com', 'www.meet.google.com'])
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i
const COMPACT_MEET_CODE_RE = /^[a-z]{10}$/i
const DEFAULT_TRANSCRIPTION_PROVIDER: MeetingTranscriptionProvider = 'deepgram'
const DEFAULT_TRANSCRIPTION_MODEL_BY_PROVIDER: Record<MeetingTranscriptionProvider, string> = {
  deepgram: 'nova-3',
  groq: 'whisper-large-v3-turbo',
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

  constructor(private readonly browserPaneManager: BrowserPaneManager, private readonly storePathOverride?: string) {}

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
      title: payload?.title,
      startedAt: now,
      updatedAt: now,
      endedAt: undefined,
      error: undefined,
      transcriptionProvider,
      transcriptionModel,
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

    try {
      // If the meeting was detected from an already-open Browser Pane, reuse it
      // instead of creating/navigating another user browser. The separate Hermes
      // bot is started below by the google_meet Playwright process.
      if (!existingBrowserInstance) {
        await this.browserPaneManager.navigate(browserInstanceId, normalized.url)
        this.browserPaneManager.focus(browserInstanceId)
      }

      if (captureMode === 'hermes' && payload.transcribe !== false) {
        mainLog.info(`[meetings] starting Hermes Meet bot url=${normalized.url} profileId=${payload.profileId ?? 'default'} browserInstanceId=${browserInstanceId}`)
        const botStart = await this.runHermesMeetPlugin('start', { url: normalized.url, headed: true })
        if (!botStart.ok) {
          throw new Error(botStart.error || botStart.reason || 'Hermes Google Meet bot did not start')
        }
        const botStatus = await this.waitForHermesMeetBotReady(botStart, 20_000)
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.error(`[meetings] start failed id=${id} url=${normalized.url}: ${message}`)
      this.updateRecord(state, id, {
        status: 'error',
        error: message,
      })
    }

    return this.getRequired(state, id)
  }

  list(workspaceRootPath: string): MeetingRecord[] {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    return [...state.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  status(workspaceRootPath: string, id: string): MeetingRecord | null {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    this.refreshLiveStatuses(state)
    return state.records.get(id) ?? null
  }

  stop(workspaceRootPath: string, id: string): MeetingRecord {
    const state = this.getWorkspaceState(workspaceRootPath)
    this.ensureLoaded(state)
    const record = this.getRequired(state, id)
    if (record.status === 'stopped') {
      return record
    }

    try {
      this.browserPaneManager.destroyInstance(record.browserInstanceId)
      if (record.captureMode !== 'craft') {
        void this.runHermesMeetPlugin('stop').catch(() => undefined)
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

  private async exportCraftGoogleSessionToHermesAuth(profileId?: string): Promise<void> {
    const runtime = getHermesRuntimePaths()
    if (!runtime) return

    const partition = getProfilePartition(profileId)
    const electronSession = session.fromPartition(partition)
    const cookies = await electronSession.cookies.get({})
    const googleCookies = cookies.filter((cookie) => isGoogleAuthCookieDomain(cookie.domain))

    if (googleCookies.length === 0) {
      return
    }

    const authPath = join(runtime.hermesHome, 'workspace', 'meetings', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true })

    const storageState = {
      cookies: googleCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: toPlaywrightSameSite(cookie.sameSite),
      })),
      origins: [],
    }

    atomicWriteTextFileSync(authPath, JSON.stringify(storageState, null, 2), 0o600)
  }

  private async runHermesMeetPlugin(command: 'start' | 'status' | 'transcript' | 'stop', payload: Record<string, unknown> = {}): Promise<HermesMeetPluginResult> {
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

    const { stdout } = await execFileAsync(runtime.python, ['-c', script, command, JSON.stringify(payload)], {
      cwd: runtime.hermesAgentRoot,
      env: {
        ...process.env,
        HERMES_HOME: runtime.hermesHome,
        VIRTUAL_ENV: runtime.virtualEnv,
        PATH: `${runtime.vendorBinDir}:${process.env.PATH ?? ''}`,
      },
      maxBuffer: 1024 * 1024,
    })

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mainLog.error(`[meetings] failed to load persisted meetings from ${state.storePath}: ${message}`)
      if (state.corruptDetected) {
        state.loaded = true
      } else {
        state.corruptDetected = true
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

function isGoogleAuthCookieDomain(domain: string | undefined): boolean {
  const normalized = (domain ?? '').replace(/^\./, '').toLowerCase()
  return normalized === 'google.com'
    || normalized.endsWith('.google.com')
    || normalized === 'meet.google.com'
    || normalized === 'accounts.google.com'
}

function toPlaywrightSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  if (value === 'strict' || value === 'Strict') return 'Strict'
  if (value === 'no_restriction' || value === 'none' || value === 'None') return 'None'
  return 'Lax'
}

function createTranscriptPlaceholder(record: MeetingRecord): MeetingTranscriptResult {
  const captureMode = record.captureMode ?? 'hermes'
  const message = captureMode === 'craft'
    ? 'Gravacao interna do Craft criada. Captura de audio/legendas e transcricao local ainda serao conectadas ao recorder nativo.'
    : 'Captura real de transcricao ainda nao implementada neste MVP; retorno placeholder em memoria.'
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

function createMeetingSummaryMarkdown(input: {
  title?: string
  url: string
  captureMode: 'hermes' | 'craft'
  transcriptionProvider?: MeetingTranscriptionProvider
  transcriptionModel?: string
  status: MeetingStatus
  startedAt: number
  endedAt?: number
}): string {
  const title = input.title?.trim() || 'Google Meet'
  const owner = input.captureMode === 'craft' ? 'Craft interno' : 'Hermes'
  const statusLabel = formatMeetingStatus(input.status)
  const lines = [
    `# ${title}`,
    '',
    `- Origem: ${owner}`,
    `- Status: ${statusLabel}`,
    `- Link: ${input.url}`,
    `- Inicio: ${new Date(input.startedAt).toLocaleString('pt-BR')}`,
  ]
  if (input.transcriptionProvider && input.transcriptionModel) {
    lines.push(`- Transcricao: ${formatTranscriptionProvider(input.transcriptionProvider)} / ${input.transcriptionModel}`)
  }
  if (input.endedAt) {
    lines.push(`- Fim: ${new Date(input.endedAt).toLocaleString('pt-BR')}`)
  }
  lines.push('', '## Resumo', '')
  if (input.captureMode === 'craft') {
    lines.push('Gravacao interna criada no Craft. A captura/transcricao nativa sera anexada aqui quando o recorder interno finalizar.')
  } else {
    lines.push('Reuniao registrada pelo fluxo Hermes. A transcricao capturada pelo bot sera usada aqui quando estiver disponivel.')
  }
  return lines.join('\n')
}

function formatMeetingStatus(status: MeetingStatus): string {
  switch (status) {
    case 'starting':
      return 'Iniciando'
    case 'running':
      return 'Em andamento'
    case 'stopped':
      return 'Finalizada'
    case 'error':
      return 'Erro'
    default:
      return status
  }
}

function isTranscriptionProvider(value: unknown): value is MeetingTranscriptionProvider {
  return value === 'deepgram' || value === 'groq'
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
  return provider === 'groq' ? 'Groq' : 'Deepgram'
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
      transcriptionProvider = DEFAULT_TRANSCRIPTION_PROVIDER
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
  }
}
