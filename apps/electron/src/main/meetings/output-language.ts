import { i18n } from '@craft-agent/shared/i18n'

/**
 * Nome do idioma ativo do app, no próprio idioma, para instruir LLMs sobre a
 * língua de saída. O fallback é inglês — o mesmo do i18n quando não inicializado.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  'pt-BR': 'Português (Brasil)',
  pt: 'Português',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  hu: 'Magyar',
  ja: '日本語',
  pl: 'Polski',
  'zh-Hans': '简体中文',
  zh: '简体中文',
}

/** Idioma em que resumos e análises gerados por LLM devem ser escritos. */
export function getOutputLanguageName(): string {
  const lang = i18n.resolvedLanguage ?? 'en'
  return LANGUAGE_NAMES[lang] ?? LANGUAGE_NAMES[lang.split('-')[0]!] ?? 'English'
}

/**
 * Código de idioma Deepgram para o locale ativo, ou `null` quando o locale não
 * é suportado — nesse caso o chamador usa `detect_language=true` em vez de
 * impor um idioma errado. Sem este parâmetro o Deepgram assume inglês e
 * transcreve áudio em outro idioma como fonética inglesa.
 */
const DEEPGRAM_LANGUAGE_CODES: Record<string, string> = {
  'pt-BR': 'pt-BR',
  pt: 'pt',
  en: 'en',
  de: 'de',
  es: 'es',
  hu: 'hu',
  ja: 'ja',
  pl: 'pl',
  'zh-Hans': 'zh',
  zh: 'zh',
}

export function toDeepgramLanguage(locale: string | undefined): string | null {
  if (!locale) return null
  return DEEPGRAM_LANGUAGE_CODES[locale] ?? DEEPGRAM_LANGUAGE_CODES[locale.split('-')[0]!] ?? null
}
