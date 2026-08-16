import { describe, expect, it } from 'bun:test'
import type { MeetingRecord } from '../../../shared/types'
import { getRecordingMediaUrl } from '@/lib/meeting-recording-preview'

const RECORDING_PATH = '/tmp/craft/meetings/recordings/meeting-1.webm'

function makeRecord(overrides: Partial<MeetingRecord>): MeetingRecord {
  return {
    id: 'meeting-1',
    provider: 'google-meet',
    captureMode: 'craft',
    status: 'stopped',
    url: 'https://meet.google.com/abc-defg-hij',
    browserInstanceId: 'browser-1',
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** Estado do record enquanto a gravação roda: path referenciado no primeiro byte. */
const recording = makeRecord({
  status: 'running',
  recording: { path: RECORDING_PATH, bytesWritten: 0, durationMs: 0, partial: true },
})

/** Selado por `completeRecording`, com o pós-processamento ainda em voo. */
const processing = makeRecord({
  status: 'stopped',
  postProcessingPhase: 'transcribing',
  recording: { path: RECORDING_PATH, bytesWritten: 4096, durationMs: 60_000 },
})

/** Depois do remux: MESMO path, conteúdo trocado por `renameSync`. */
const remuxed = makeRecord({
  status: 'stopped',
  postProcessingPhase: 'analyzing',
  recording: { path: RECORDING_PATH, bytesWritten: 4130, durationMs: 60_000, remuxedAt: 1_700_000_000_000 },
})

describe('getRecordingMediaUrl', () => {
  it('has no media without a referenced recording', () => {
    expect(getRecordingMediaUrl(null)).toBeNull()
    expect(getRecordingMediaUrl(makeRecord({}))).toBeNull()
  })

  it('serves the preview while the recording is still being written', () => {
    const url = getRecordingMediaUrl(recording)
    expect(url).toContain(`media://recording/${encodeURIComponent(RECORDING_PATH)}`)
  })

  it('serves the preview while post-processing is still running', () => {
    // A prévia não espera o fim do pipeline: o `.webm` já está selado.
    const url = getRecordingMediaUrl(processing)
    expect(url).toContain(`media://recording/${encodeURIComponent(RECORDING_PATH)}`)
  })

  it('reloads the player when the seal replaces the growing file', () => {
    expect(getRecordingMediaUrl(processing)).not.toBe(getRecordingMediaUrl(recording))
  })

  it('reloads the player when the remux replaces the file at the same path', () => {
    const before = getRecordingMediaUrl(processing)
    const after = getRecordingMediaUrl(remuxed)
    // O path é idêntico — é exatamente por isso que ele não pode ser a key.
    expect(after).toContain(encodeURIComponent(RECORDING_PATH))
    expect(before).toContain(encodeURIComponent(RECORDING_PATH))
    expect(after).not.toBe(before)
  })

  it('reloads the player when only remuxedAt changes', () => {
    // O remux com `-c copy` pode devolver um arquivo do mesmo tamanho: aqui
    // `bytesWritten` e `partial` são idênticos e só `remuxedAt` é novo. É o MUST
    // do AGENTS.md — sem versionar por `remuxedAt`, a URL ficaria igual e o
    // <video> continuaria preso à mídia sem Duration/Cues. Este teste falha se
    // `remuxedAt` for ignorado na versão.
    const sealed = makeRecord({
      status: 'stopped',
      postProcessingPhase: 'transcribing',
      recording: { path: RECORDING_PATH, bytesWritten: 4130, durationMs: 60_000 },
    })
    const remuxedSameSize = makeRecord({
      status: 'stopped',
      postProcessingPhase: 'analyzing',
      recording: { path: RECORDING_PATH, bytesWritten: 4130, durationMs: 60_000, remuxedAt: 1_700_000_000_000 },
    })
    expect(getRecordingMediaUrl(remuxedSameSize)).not.toBe(getRecordingMediaUrl(sealed))
  })

  it('keeps the same media stable across polls that change nothing', () => {
    // O poll de 1,5s reentrega o mesmo record: remontar o `<video>` a cada
    // resposta cortaria a reprodução em andamento.
    expect(getRecordingMediaUrl(remuxed)).toBe(getRecordingMediaUrl(makeRecord({
      status: 'stopped',
      updatedAt: 99,
      postProcessingPhase: 'completed',
      recording: { path: RECORDING_PATH, bytesWritten: 4130, durationMs: 60_000, remuxedAt: 1_700_000_000_000 },
    })))
  })
})
