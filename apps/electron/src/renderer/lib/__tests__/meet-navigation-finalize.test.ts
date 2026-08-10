import { describe, expect, it } from 'bun:test'
import { shouldFinalizeOnMeetNavigation } from '../meet-navigation-finalize'

/**
 * Medido em Electron 43: navegar o pane capturado NÃO encerra as faixas — a
 * gravação segue e o conteúdo novo entra no mesmo `.webm`. Este helper é o sinal
 * que falta, então ele decide por sair da reunião, não por "a URL mudou".
 */
describe('shouldFinalizeOnMeetNavigation', () => {
  const meetUrl = 'https://meet.google.com/kdj-qkdx-gwd'

  it('finalizes when the pane leaves the meeting', () => {
    expect(shouldFinalizeOnMeetNavigation(meetUrl, 'https://example.com/docs')).toBe(true)
    expect(shouldFinalizeOnMeetNavigation(meetUrl, 'about:blank')).toBe(true)
    expect(shouldFinalizeOnMeetNavigation(meetUrl, 'https://meet.google.com/')).toBe(true)
  })

  it('finalizes when the pane moves to a different meeting', () => {
    expect(shouldFinalizeOnMeetNavigation(meetUrl, 'https://meet.google.com/abc-defg-hij')).toBe(true)
  })

  it('keeps recording within the same meeting', () => {
    expect(shouldFinalizeOnMeetNavigation(meetUrl, meetUrl)).toBe(false)
    // Query e fragmento do próprio Meet (ex.: ?authuser, #heartbeat) não são saída.
    expect(shouldFinalizeOnMeetNavigation(meetUrl, `${meetUrl}?authuser=1`)).toBe(false)
    expect(shouldFinalizeOnMeetNavigation(meetUrl, `${meetUrl}#pip`)).toBe(false)
    // Subpaths do mesmo código continuam sendo a mesma reunião.
    expect(shouldFinalizeOnMeetNavigation(meetUrl, `${meetUrl}/companion`)).toBe(false)
  })

  it('never finalizes without a known recording URL or before the first state update', () => {
    // Sem reunião ativa não há gravação para encerrar; URL vazia é o estado
    // inicial da toolbar, não uma saída.
    expect(shouldFinalizeOnMeetNavigation(null, 'https://example.com')).toBe(false)
    expect(shouldFinalizeOnMeetNavigation(meetUrl, '')).toBe(false)
    expect(shouldFinalizeOnMeetNavigation(meetUrl, undefined)).toBe(false)
  })

  it('treats an unparseable current url as staying put', () => {
    // Um valor inesperado não pode matar a gravação: só saída comprovada encerra.
    expect(shouldFinalizeOnMeetNavigation(meetUrl, 'not a url')).toBe(false)
  })
})
