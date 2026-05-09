import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type {
  MeetingRecord,
  MeetingStartInput,
  MeetingStatus,
  MeetingTranscriptResult,
} from '../../shared/types'
import type { BrowserPaneManager } from '../browser-pane-manager'

const GOOGLE_MEET_HOSTS = new Set(['meet.google.com', 'www.meet.google.com'])
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i
const COMPACT_MEET_CODE_RE = /^[a-z]{10}$/i

interface PersistedMeetingsStore {
  meetings: MeetingRecord[]
}

export class MeetingService {
  private readonly records = new Map<string, MeetingRecord>()
  private readonly transcripts = new Map<string, MeetingTranscriptResult>()
  private readonly storePath: string
  private loaded = false

  constructor(private readonly browserPaneManager: BrowserPaneManager, storePath?: string) {
    this.storePath = storePath ?? join(app.getPath('userData'), 'meetings', 'meetings.json')
  }

  async start(input: string | MeetingStartInput): Promise<MeetingRecord> {
    this.ensureLoaded()
    const payload = typeof input === 'string' ? { urlOrCode: input } : input
    const normalized = normalizeGoogleMeetUrl(payload?.urlOrCode)
    const now = Date.now()
    const id = randomUUID()
    const browserInstanceId = this.browserPaneManager.createInstance(undefined, {
      show: true,
      profileId: payload?.profileId,
    })

    const record: MeetingRecord = {
      id,
      provider: 'google-meet',
      status: 'starting',
      url: normalized.url,
      code: normalized.code,
      browserInstanceId,
      title: payload?.title,
      startedAt: now,
      updatedAt: now,
      endedAt: undefined,
      error: undefined,
    }

    this.records.set(id, record)
    this.transcripts.set(id, createTranscriptPlaceholder(record))
    this.persist()

    try {
      // Navigate explicitly after the BrowserView is created. Some pages, including
      // Google Meet, may internally redirect and make Electron report ERR_ABORTED
      // for the initial load even though the browser continues navigating.
      await this.browserPaneManager.navigate(browserInstanceId, normalized.url)
      // Bring the meeting window forward again after the real navigation is started.
      this.browserPaneManager.focus(browserInstanceId)
      this.updateRecord(id, { status: 'running', error: undefined })
    } catch (error) {
      this.updateRecord(id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return this.getRequired(id)
  }

  list(): MeetingRecord[] {
    this.ensureLoaded()
    this.refreshLiveStatuses()
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  status(id: string): MeetingRecord | null {
    this.ensureLoaded()
    this.refreshLiveStatuses()
    return this.records.get(id) ?? null
  }

  stop(id: string): MeetingRecord {
    this.ensureLoaded()
    const record = this.getRequired(id)
    if (record.status === 'stopped') {
      return record
    }

    try {
      this.browserPaneManager.destroyInstance(record.browserInstanceId)
      this.updateRecord(id, { status: 'stopped', endedAt: Date.now(), error: undefined })
    } catch (error) {
      this.updateRecord(id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return this.getRequired(id)
  }

  transcript(id: string): MeetingTranscriptResult {
    this.ensureLoaded()
    const record = this.records.get(id)
    if (!record) {
      throw new Error(`Meeting not found: ${id}`)
    }

    const existing = this.transcripts.get(id)
    if (existing) return existing

    const placeholder = createTranscriptPlaceholder(record)
    this.transcripts.set(id, placeholder)
    return placeholder
  }

  private getRequired(id: string): MeetingRecord {
    const record = this.records.get(id)
    if (!record) {
      throw new Error(`Meeting not found: ${id}`)
    }
    return record
  }

  private updateRecord(id: string, updates: Partial<MeetingRecord>): void {
    const existing = this.getRequired(id)
    this.records.set(id, {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    })
    this.persist()
  }

  private refreshLiveStatuses(): void {
    let changed = false
    for (const record of this.records.values()) {
      if (!['starting', 'running'].includes(record.status)) continue
      const instance = this.browserPaneManager.getInstance(record.browserInstanceId)
      if (instance) continue
      this.records.set(record.id, {
        ...record,
        status: 'stopped',
        endedAt: record.endedAt ?? Date.now(),
        updatedAt: Date.now(),
      })
      changed = true
    }
    if (changed) this.persist()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.storePath)) return
      const raw = readFileSync(this.storePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedMeetingsStore
      for (const record of Array.isArray(parsed.meetings) ? parsed.meetings : []) {
        const safeRecord = sanitizeRecord(record)
        if (safeRecord) {
          this.records.set(safeRecord.id, safeRecord)
          this.transcripts.set(safeRecord.id, createTranscriptPlaceholder(safeRecord))
        }
      }
    } catch {
      // Corrupt/old stores should not block app startup; the next mutation rewrites it.
    }
  }

  private persist(): void {
    const dir = dirname(this.storePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: PersistedMeetingsStore = {
      meetings: [...this.records.values()],
    }
    writeFileSync(this.storePath, JSON.stringify(payload, null, 2), 'utf8')
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
  return {
    meetingId: record.id,
    status: 'placeholder',
    transcript: [],
    message: 'Captura real de transcrição ainda não implementada neste MVP; retorno placeholder em memória.',
    updatedAt: Date.now(),
  }
}

function sanitizeRecord(record: MeetingRecord): MeetingRecord | null {
  if (!record || typeof record.id !== 'string' || typeof record.url !== 'string' || typeof record.browserInstanceId !== 'string') {
    return null
  }
  const status: MeetingStatus = ['starting', 'running', 'stopped', 'error'].includes(record.status)
    ? record.status
    : 'stopped'
  return {
    ...record,
    provider: 'google-meet',
    status: status === 'running' || status === 'starting' ? 'stopped' : status,
    startedAt: Number(record.startedAt) || Date.now(),
    updatedAt: Number(record.updatedAt) || Date.now(),
    endedAt: record.endedAt,
  }
}
