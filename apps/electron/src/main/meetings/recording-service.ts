import { createWriteStream, mkdirSync, unlinkSync, type WriteStream } from 'fs'
import { once } from 'node:events'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { mainLog } from '../logger'
import { getWorkspaceMeetingsPath } from '@craft-agent/shared/workspaces'

interface ActiveRecording {
  id: string
  workspaceId: string
  browserInstanceId: string
  meetingId?: string
  outputPath: string
  /** Escolhido pelo renderer antes do prepare, para o main poder selar sozinho. */
  mimeType: string
  stream: WriteStream
  startedAt: number
  bytesWritten: number
  /** Set when the write stream emits an error; append/finalize stop touching it. */
  streamError?: Error
}

export interface PrepareRecordingInput {
  workspaceId: string
  workspaceRoot: string
  browserInstanceId: string
  meetingId?: string
  urlOrCode?: string
  /**
   * Mime do MediaRecorder, decidido antes do prepare. Sem ele o main não
   * conseguiria selar a gravação no quit, quando o renderer já não existe.
   */
  mimeType: string
}

export interface PrepareRecordingResult {
  recordingId: string
  meetingId?: string
  outputPath: string
}

export interface FinalizeRecordingResult {
  recordingId: string
  meetingId?: string
  workspaceId: string
  outputPath: string
  bytesWritten: number
  durationMs: number
  mimeType: string
  /** Pane dono, para o chamador liberar o captureLock da instância. */
  browserInstanceId: string
}

export class RecordingService {
  private readonly recordings = new Map<string, ActiveRecording>()

  constructor(private readonly browserPaneManager: BrowserPaneManager) {}

  prepare(input: PrepareRecordingInput): PrepareRecordingResult {
    const instance = this.browserPaneManager.getLiveInstance(input.browserInstanceId)
    if (!instance) {
      throw new Error(`browser instance not found: ${input.browserInstanceId}`)
    }
    const recordingsDir = join(getWorkspaceMeetingsPath(input.workspaceRoot), 'recordings')
    mkdirSync(recordingsDir, { recursive: true })

    const id = randomUUID()
    const outputPath = join(recordingsDir, `${id}.webm`)
    const stream = createWriteStream(outputPath, { flags: 'w' })

    const recording: ActiveRecording = {
      id,
      workspaceId: input.workspaceId,
      browserInstanceId: input.browserInstanceId,
      meetingId: input.meetingId,
      outputPath,
      mimeType: input.mimeType,
      stream,
      startedAt: Date.now(),
      bytesWritten: 0,
    }
    // Without an error listener a failed write would crash the process with an
    // unhandled 'error' event. Capture it so append/finalize can surface it.
    stream.on('error', (err: Error) => {
      recording.streamError = err
      mainLog.error(`[recording] write stream error id=${id}: ${err.message}`)
    })

    this.recordings.set(id, recording)

    mainLog.info(`[recording] prepared id=${id} pane=${input.browserInstanceId} mime=${input.mimeType} -> ${outputPath}`)
    return { recordingId: id, meetingId: input.meetingId, outputPath }
  }

  /**
   * Pane dono de uma gravação ativa. Existe para o handler liberar o
   * `captureLock` mesmo quando `finalize` lança — nesse caminho não há resultado
   * de onde tirar o id, e um lock vazado tornaria o pane inadotável para sempre.
   */
  getBrowserInstanceId(recordingId: string): string | null {
    return this.recordings.get(recordingId)?.browserInstanceId ?? null
  }

  async append(recordingId: string, chunk: ArrayBuffer | Uint8Array): Promise<void> {
    const recording = this.recordings.get(recordingId)
    if (!recording) {
      throw new Error(`recording not found: ${recordingId}`)
    }
    if (recording.streamError) {
      throw new Error(`recording stream failed: ${recording.streamError.message}`)
    }
    if (recording.stream.writableEnded || recording.stream.destroyed) {
      throw new Error(`recording stream already closed: ${recordingId}`)
    }
    const buffer = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk as ArrayBuffer)
    if (!recording.stream.write(buffer)) {
      await once(recording.stream, 'drain')
    }
    recording.bytesWritten += buffer.byteLength
  }

  /**
   * `mimeType` é opcional porque o seal de quit acontece sem o renderer: nesse
   * caminho vale o mime guardado no prepare.
   */
  async finalize(recordingId: string, mimeType?: string): Promise<FinalizeRecordingResult> {
    const recording = this.recordings.get(recordingId)
    if (!recording) {
      throw new Error(`recording not found: ${recordingId}`)
    }
    this.recordings.delete(recordingId)
    if (recording.streamError) {
      try { recording.stream.destroy() } catch { /* ignore */ }
      throw new Error(`recording stream failed: ${recording.streamError.message}`)
    }
    const effectiveMimeType = mimeType ?? recording.mimeType
    await new Promise<void>((resolve, reject) => {
      recording.stream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()))
    })
    const durationMs = Date.now() - recording.startedAt
    mainLog.info(`[recording] finalized id=${recordingId} bytes=${recording.bytesWritten} duration=${durationMs}ms mime=${effectiveMimeType} -> ${recording.outputPath}`)
    return {
      recordingId,
      meetingId: recording.meetingId,
      workspaceId: recording.workspaceId,
      outputPath: recording.outputPath,
      bytesWritten: recording.bytesWritten,
      durationMs,
      mimeType: effectiveMimeType,
      browserInstanceId: recording.browserInstanceId,
    }
  }

  /**
   * Sela toda gravação ativa sem passar pelo renderer (quit e relaunch). Uma
   * stream com erro é logada e pulada: uma gravação ruim não pode impedir o
   * seal das outras.
   */
  async finalizeAll(): Promise<FinalizeRecordingResult[]> {
    return this.finalizeMany([...this.recordings.keys()])
  }

  /** Mesma semântica de `finalizeAll`, restrita ao pane dono. */
  async finalizeForInstance(browserInstanceId: string): Promise<FinalizeRecordingResult[]> {
    const ids = [...this.recordings.values()]
      .filter((recording) => recording.browserInstanceId === browserInstanceId)
      .map((recording) => recording.id)
    return this.finalizeMany(ids)
  }

  private async finalizeMany(recordingIds: string[]): Promise<FinalizeRecordingResult[]> {
    const settled = await Promise.allSettled(recordingIds.map((id) => this.finalize(id)))
    const results: FinalizeRecordingResult[] = []
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
        return
      }
      const reason: unknown = outcome.reason
      mainLog.error(
        `[recording] finalize failed id=${recordingIds[index]}: ${reason instanceof Error ? reason.message : String(reason)}`,
      )
    })
    return results
  }

  /**
   * Abort discards the capture: removes the partial .webm from disk
   * (best-effort, after the stream closes) and returns the owning ids so the
   * caller can close the associated meeting record.
   */
  abort(recordingId: string): { meetingId?: string; workspaceId: string; browserInstanceId: string } | null {
    const recording = this.recordings.get(recordingId)
    if (!recording) return null
    this.recordings.delete(recordingId)
    const removePartialFile = () => {
      try {
        unlinkSync(recording.outputPath)
      } catch {
        // Best-effort cleanup; a missing/locked file must not break abort.
      }
    }
    try {
      if (recording.stream.closed) {
        removePartialFile()
      } else {
        recording.stream.once('close', removePartialFile)
        recording.stream.destroy()
      }
    } catch {
      removePartialFile()
    }
    mainLog.info(`[recording] aborted id=${recordingId}; partial file removed ${recording.outputPath}`)
    return { meetingId: recording.meetingId, workspaceId: recording.workspaceId, browserInstanceId: recording.browserInstanceId }
  }
}
