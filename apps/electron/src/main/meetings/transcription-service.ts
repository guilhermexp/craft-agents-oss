import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { MeetingTranscriptSegment } from '@craft-agent/shared/protocol'
import { mainLog } from '../logger'

export interface TranscribeInput {
  filePath: string
  model: string
  apiKey: string
  mimeType?: string
}

export interface TranscribeOutput {
  segments: MeetingTranscriptSegment[]
  text: string
}

export class TranscriptionService {
  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    const { filePath, model, apiKey, mimeType } = input
    const audioData = await readFile(filePath)

    const url = new URL('https://api.deepgram.com/v1/listen')
    url.searchParams.set('model', model)
    url.searchParams.set('punctuate', 'true')
    url.searchParams.set('diarize', 'true')
    url.searchParams.set('utterances', 'true')

    // Deepgram wants a clean container content-type, not the MediaRecorder mime
    // string. The recorder hands us `video/webm;codecs=vp9,opus`; passing that
    // verbatim (video/ prefix + codecs param) can break Deepgram's demux and
    // yield an empty transcript. Strip to the audio container type.
    const contentType = toDeepgramContentType(mimeType)

    mainLog.info(`[transcription] starting Deepgram transcription: model=${model} file=${filePath} size=${audioData.byteLength} contentType=${contentType}`)

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: audioData,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(`Deepgram API error ${response.status}: ${errorBody.slice(0, 200)}`)
    }

    const result = (await response.json()) as DeepgramResponse

    const segments = parseDeepgramUtterances(result)
    const text = segments.map((s) => s.text).join(' ')

    mainLog.info(`[transcription] completed: ${segments.length} segments, ${text.length} chars`)
    return { segments, text }
  }
}

/**
 * Normalize a MediaRecorder mime string to a Deepgram-friendly container
 * content-type: drop the `;codecs=…` parameter and map `video/webm` → `audio/webm`.
 */
function toDeepgramContentType(mimeType?: string): string {
  const base = (mimeType ?? 'audio/webm').split(';')[0]!.trim().toLowerCase()
  if (!base) return 'audio/webm'
  return base.startsWith('video/') ? base.replace('video/', 'audio/') : base
}

interface DeepgramUtterance {
  id?: string
  start: number
  end: number
  transcript: string
  speaker?: number
  channel?: number
}

interface DeepgramResponse {
  results?: {
    utterances?: DeepgramUtterance[]
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string
        paragraphs?: {
          paragraphs?: Array<{
            sentences?: Array<{ text: string; start: number; end: number }>
            speaker?: number
          }>
        }
      }>
    }>
  }
}

function parseDeepgramUtterances(response: DeepgramResponse): MeetingTranscriptSegment[] {
  const utterances = response.results?.utterances
  if (utterances && utterances.length > 0) {
    return utterances.map((u) => ({
      id: u.id || randomUUID(),
      speaker: u.speaker != null ? `Speaker ${u.speaker}` : undefined,
      text: u.transcript,
      startedAt: Math.round(u.start * 1000),
      endedAt: Math.round(u.end * 1000),
      timestamp: Math.round(u.start * 1000),
    }))
  }

  // Fallback: parse from channels[0].alternatives[0].paragraphs
  const channel = response.results?.channels?.[0]
  const alt = channel?.alternatives?.[0]
  if (alt?.paragraphs?.paragraphs) {
    const segments: MeetingTranscriptSegment[] = []
    for (const para of alt.paragraphs.paragraphs) {
      for (const sentence of para.sentences ?? []) {
        segments.push({
          id: randomUUID(),
          speaker: para.speaker != null ? `Speaker ${para.speaker}` : undefined,
          text: sentence.text,
          startedAt: Math.round(sentence.start * 1000),
          endedAt: Math.round(sentence.end * 1000),
          timestamp: Math.round(sentence.start * 1000),
        })
      }
    }
    if (segments.length > 0) return segments
  }

  // Final fallback: full transcript as single segment
  const fullTranscript = response.results?.channels?.[0]?.alternatives?.[0]?.transcript
  if (fullTranscript) {
    return [
      {
        id: randomUUID(),
        speaker: undefined,
        text: fullTranscript,
        timestamp: 0,
      },
    ]
  }

  return []
}
