import type { MeetingRecord } from '../../shared/types'

/**
 * URL da prévia da gravação, versionada pelo estado da mídia no disco.
 *
 * O `.webm` é referenciado no record desde o primeiro byte, então a prévia
 * existe muito antes do fim do pós-processamento. O problema é o inverso: o
 * arquivo é reescrito no MESMO path — `completeRecording` sela o parcial e o
 * remux troca o conteúdo por um com Duration e Cues via `renameSync`. Uma URL
 * derivada só do path é idêntica nos três estados, então o `<video>` nunca
 * remonta nem recarrega e fica preso à mídia sem índice que carregou durante a
 * gravação: duração infinita e nenhum seek.
 *
 * O token de versão muda exatamente quando o arquivo muda (selar, remuxar) e
 * fica estável no resto dos polls, para não cortar uma reprodução em andamento.
 * Ele vai na query porque o handler `media://` resolve o path pelo pathname:
 * assim o Chromium trata a mídia nova como outro recurso em vez de servir a
 * resposta antiga do cache.
 */
export function getRecordingMediaUrl(record: MeetingRecord | null): string | null {
  const recording = record?.recording
  if (!recording?.path) return null
  const version = [
    recording.partial ? 'partial' : 'sealed',
    recording.bytesWritten ?? 0,
    recording.remuxedAt ?? 0,
  ].join('-')
  return `media://recording/${encodeURIComponent(recording.path)}?v=${version}`
}
