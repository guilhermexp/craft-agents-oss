/**
 * Tempo decorrido de uma gravação: `m:ss` abaixo de uma hora, `h:mm:ss` a partir
 * dela. Entrada inválida (negativa, `NaN`, infinita) vira `0:00` — o relógio do
 * renderer pode andar para trás e o indicador não pode exibir tempo negativo.
 *
 * É só indicador: a duração autoritativa vem de `RecordingService.finalize`.
 */
export function formatRecordingElapsed(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const paddedSeconds = String(seconds).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`
}
