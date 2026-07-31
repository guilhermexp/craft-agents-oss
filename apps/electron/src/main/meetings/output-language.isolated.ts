// Isolated: meeting-service.test.ts mocks shared i18n adjacent modules in the
// same bun process. Keep the real imports alone here.
import { describe, expect, it } from 'bun:test'

const { toDeepgramLanguage } = await import('./output-language')

describe('toDeepgramLanguage', () => {
  it('maps supported locales to Deepgram codes', () => {
    expect(toDeepgramLanguage('pt-BR')).toBe('pt-BR')
    expect(toDeepgramLanguage('pt')).toBe('pt')
    expect(toDeepgramLanguage('en')).toBe('en')
    expect(toDeepgramLanguage('zh-Hans')).toBe('zh')
  })

  it('falls back to the base language for unknown regional variants', () => {
    expect(toDeepgramLanguage('pt-PT')).toBe('pt')
    expect(toDeepgramLanguage('en-US')).toBe('en')
  })

  it('returns null for unsupported or missing locales so the caller detects', () => {
    // Sem código mapeado, impor um idioma errado é pior que detectar.
    expect(toDeepgramLanguage('fr-FR')).toBeNull()
    expect(toDeepgramLanguage(undefined)).toBeNull()
  })
})
