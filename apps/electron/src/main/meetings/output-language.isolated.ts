// Isolated: meeting-service.test.ts mocks shared i18n adjacent modules in the
// same bun process. Keep the real imports alone here.
//
// The output language and the STT language code both derive from the persisted
// `uiLanguage` preference, so this file points `CRAFT_CONFIG_DIR` at a tmpdir
// before the first import: `CONFIG_DIR` is captured when the config module loads.
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'meeting-output-language-'))
process.env.CRAFT_CONFIG_DIR = configDir
const prefsFile = join(configDir, 'preferences.json')

const { getOutputLanguageName, getTranscriptionLanguage, toDeepgramLanguage } = await import(
  './output-language'
)

function persistUiLanguage(code: string): void {
  writeFileSync(prefsFile, JSON.stringify({ uiLanguage: code }), 'utf-8')
}

afterEach(() => {
  rmSync(prefsFile, { force: true })
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('getOutputLanguageName', () => {
  it('resolves the persisted UI language instead of the main i18n fallback', () => {
    // O i18n do main segue em `en` neste processo — a preferência é a fonte.
    persistUiLanguage('pt-BR')
    expect(getOutputLanguageName()).toBe('Português (Brasil)')
  })

  it('returns null without a persisted preference so the caller asks for the transcript language', () => {
    expect(getOutputLanguageName()).toBeNull()
  })

  it('returns null for an unsupported persisted code instead of falling back to English', () => {
    persistUiLanguage('xx')
    expect(getOutputLanguageName()).toBeNull()
  })
})

describe('getTranscriptionLanguage', () => {
  it('derives the Deepgram code from the persisted preference', () => {
    persistUiLanguage('pt-BR')
    expect(getTranscriptionLanguage()).toBe('pt-BR')
  })

  it('maps a persisted locale whose Deepgram code differs', () => {
    persistUiLanguage('zh-Hans')
    expect(getTranscriptionLanguage()).toBe('zh')
  })

  it('is null without a persisted preference so Deepgram detects the language', () => {
    // Impor `en` sobre áudio em português foi o bug: transcrição vazia ou
    // fonética inglesa.
    expect(getTranscriptionLanguage()).toBeNull()
  })
})

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
