import type { MeetingPostProcessingPhase, MeetingRecord } from '../../shared/types'

/**
 * Rótulo de cada etapa do pós-processamento. Só as não terminais aparecem:
 * `completed` volta ao status do record e `failed` tem estado próprio.
 */
const POST_PROCESSING_LABEL_KEYS: Record<MeetingPostProcessingPhase, string | null> = {
  preparing: 'meetings.statusProcessingPreparing',
  transcribing: 'meetings.statusProcessingTranscribing',
  analyzing: 'meetings.statusProcessingAnalyzing',
  failed: 'meetings.statusProcessingFailed',
  completed: null,
}

/**
 * Verdadeiro enquanto o pipeline pós-gravação ainda trabalha. É o que impede a
 * página de cair para o poll lento enquanto remux, transcrição e análise visual
 * — minutos de trabalho — ainda não resolveram.
 */
export function isMeetingPostProcessingRunning(record: MeetingRecord): boolean {
  const phase = record.postProcessingPhase
  return phase !== undefined && phase !== 'completed' && phase !== 'failed'
}

/**
 * Chave i18n do status exibido para uma reunião.
 *
 * Um record `stopped` cujo `recording.partial` ficou verdadeiro nunca foi selado
 * (crash, quit ou destroy do pane): o arquivo está no disco, mas a captura não
 * terminou pelo caminho normal. Isso é "Interrompida", não "Finalizada" — e a
 * distinção só existe porque o parcial passou a ser preservado em vez de apagado.
 *
 * Uma gravação selada cujo pipeline ainda roda também não é "Finalizada": remux,
 * transcrição e análise visual levam minutos, e sem a fase o usuário não
 * distingue processando de terminado de falhado. O `status` do record continua
 * `stopped` durante tudo isso (D-04) — a fase é campo separado.
 */
export function meetingStatusLabelKey(record: MeetingRecord): string {
  if (record.status === 'stopped' && record.recording?.partial) {
    return 'meetings.statusInterrupted'
  }
  const phaseKey = record.status === 'stopped' && record.postProcessingPhase
    ? POST_PROCESSING_LABEL_KEYS[record.postProcessingPhase]
    : null
  if (phaseKey) return phaseKey
  switch (record.status) {
    case 'starting':
      return 'meetings.statusStarting'
    case 'running':
      return 'meetings.statusRunning'
    case 'stopped':
      return 'meetings.statusStopped'
    case 'error':
      return 'meetings.statusError'
    default:
      return 'meetings.statusStopped'
  }
}
