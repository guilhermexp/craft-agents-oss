import { LOCALE_REGISTRY } from '@craft-agent/shared/i18n'
import { getPersistedUiLanguage } from '@craft-agent/shared/config'

/**
 * Idioma da saída de reunião — resumo, análise visual e STT — derivado da
 * preferência persistida em `preferences.json`, não de `i18n.resolvedLanguage`.
 * O i18n do main hidrata tarde (#885) e já entregou análise em inglês sobre
 * reunião em português, com o Deepgram transcrevendo áudio PT como fonética
 * inglesa. `resolveTitleLanguageName()` segue a mesma regra.
 */

/**
 * Nome nativo do idioma pedido a LLMs, ou `null` quando o usuário nunca escolheu
 * um idioma — nesse caso o chamador pede o idioma da própria transcrição em vez
 * de impor inglês.
 */
export function getOutputLanguageName(): string | null {
  const code = getPersistedUiLanguage()
  return code ? LOCALE_REGISTRY[code].nativeName : null
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

/**
 * Idioma a pedir ao Deepgram, derivado da mesma preferência persistida.
 * `null` deixa o provedor detectar o idioma do áudio.
 */
export function getTranscriptionLanguage(): string | null {
  return toDeepgramLanguage(getPersistedUiLanguage())
}
