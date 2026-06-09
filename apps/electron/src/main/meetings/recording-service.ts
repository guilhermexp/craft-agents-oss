import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { BrowserPaneManager } from '../browser-pane-manager'
import { mainLog } from '../logger'
import { getWorkspaceMeetingsPath, getWorkspacePath } from '@craft-agent/shared/workspaces'

interface ActiveRecording {
  id: string
  workspaceId: string
  browserInstanceId: string
  meetingId?: string
  outputPath: string
  stream: WriteStream
  startedAt: number
  bytesWritten: number
  /** Set when the write stream emits an error; append/finalize stop touching it. */
  streamError?: Error
}

export interface PrepareRecordingInput {
  workspaceId: string
  browserInstanceId: string
  meetingId?: string
  urlOrCode?: string
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
}

export class RecordingService {
  private readonly recordings = new Map<string, ActiveRecording>()

  constructor(private readonly browserPaneManager: BrowserPaneManager) {}

  prepare(input: PrepareRecordingInput): PrepareRecordingResult {
    const instance = this.browserPaneManager.getInstance(input.browserInstanceId)
    if (!instance) {
      throw new Error(`browser instance not found: ${input.browserInstanceId}`)
    }
    const workspaceRoot = getWorkspacePath(input.workspaceId)
    if (!workspaceRoot) {
      throw new Error(`workspace not found: ${input.workspaceId}`)
    }
    const recordingsDir = join(getWorkspaceMeetingsPath(workspaceRoot), 'recordings')
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

    mainLog.info(`[recording] prepared id=${id} pane=${input.browserInstanceId} -> ${outputPath}`)
    return { recordingId: id, meetingId: input.meetingId, outputPath }
  }

  append(recordingId: string, chunk: ArrayBuffer | Uint8Array): void {
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
    recording.stream.write(buffer)
    recording.bytesWritten += buffer.byteLength
  }

  async finalize(recordingId: string, mimeType: string): Promise<FinalizeRecordingResult> {
    const recording = this.recordings.get(recordingId)
    if (!recording) {
      throw new Error(`recording not found: ${recordingId}`)
    }
    this.recordings.delete(recordingId)
    if (recording.streamError) {
      try { recording.stream.destroy() } catch { /* ignore */ }
      throw new Error(`recording stream failed: ${recording.streamError.message}`)
    }
    await new Promise<void>((resolve, reject) => {
      recording.stream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()))
    })
    const durationMs = Date.now() - recording.startedAt
    mainLog.info(`[recording] finalized id=${recordingId} bytes=${recording.bytesWritten} duration=${durationMs}ms mime=${mimeType} -> ${recording.outputPath}`)
    return {
      recordingId,
      meetingId: recording.meetingId,
      workspaceId: recording.workspaceId,
      outputPath: recording.outputPath,
      bytesWritten: recording.bytesWritten,
      durationMs,
    }
  }

  abort(recordingId: string): void {
    const recording = this.recordings.get(recordingId)
    if (!recording) return
    this.recordings.delete(recordingId)
    try {
      recording.stream.destroy()
    } catch {
      // ignore
    }
    mainLog.info(`[recording] aborted id=${recordingId}`)
  }
}
