const GOOGLE_MEET_PREFIX = 'https://meet.google.com/'

/**
 * Normaliza qualquer URL/código de Google Meet para `https://meet.google.com/<código>`,
 * ou `null` quando não há reunião identificável.
 */
export function extractGoogleMeetMeetingUrl(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.hostname !== 'meet.google.com') return null
    const match = url.pathname.toLowerCase().match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/)
    return match ? `${GOOGLE_MEET_PREFIX}${match[1]}` : null
  } catch {
    const match = value.toLowerCase().match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/)
    return match ? `${GOOGLE_MEET_PREFIX}${match[1]}` : null
  }
}

/**
 * Decide se uma gravação craft em curso deve ser finalizada porque o pane saiu da
 * reunião.
 *
 * Existe porque navegar o pane capturado NÃO encerra as faixas de mídia (medido
 * em Electron 43): sem este sinal a gravação continuaria, gravando a página nova
 * dentro do mesmo `.webm`. O auto-finalize por `track.ended` segue cobrindo
 * "Stop sharing" e o teardown do frame capturado.
 *
 * Conservador de propósito: só encerra com saída comprovada. Sem gravação ativa,
 * sem URL corrente, ou com uma URL que nem parseia, a resposta é `false` — um
 * estado desconhecido não pode matar a captura.
 */
export function shouldFinalizeOnMeetNavigation(
  activeRecordingMeetUrl: string | null | undefined,
  currentUrl: string | null | undefined,
): boolean {
  if (!activeRecordingMeetUrl || !currentUrl) return false
  try {
    new URL(currentUrl)
  } catch {
    return false
  }
  const active = extractGoogleMeetMeetingUrl(activeRecordingMeetUrl) ?? activeRecordingMeetUrl
  return extractGoogleMeetMeetingUrl(currentUrl) !== active
}
