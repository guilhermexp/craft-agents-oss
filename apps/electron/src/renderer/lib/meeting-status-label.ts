import type { MeetingRecord } from '../../shared/types'

/**
 * Chave i18n do status exibido para uma reunião.
 *
 * Um record `stopped` cujo `recording.partial` ficou verdadeiro nunca foi selado
 * (crash, quit ou destroy do pane): o arquivo está no disco, mas a captura não
 * terminou pelo caminho normal. Isso é "Interrompida", não "Finalizada" — e a
 * distinção só existe porque o parcial passou a ser preservado em vez de apagado.
 */
export function meetingStatusLabelKey(record: MeetingRecord): string {
  if (record.status === 'stopped' && record.recording?.partial) {
    return 'meetings.statusInterrupted'
  }
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
