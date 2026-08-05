/**
 * Main-process UI language wiring.
 *
 * There is no `LanguageDetector` in the main process (no `localStorage` in
 * Node), so `setupI18n()` sits at `fallbackLng: 'en'` until something applies a
 * language. Disk is the source of truth: the Appearance dropdown reaches
 * `applyUiLanguageChange` through the `i18n:changeLanguage` IPC and every boot
 * replays the persisted code through `hydrateMainI18nFromPreferences`. Without
 * that replay the main process reverts to English on restart, which is what put
 * a Portuguese meeting through an English STT and summary pipeline.
 *
 * Meetings and session titles still read `getPersistedUiLanguage()` directly:
 * the i18n instance is for native menus and dialogs, not the source of truth
 * for generated output (#885).
 */
import { i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@craft-agent/shared/i18n'
import { getPersistedUiLanguage, setPersistedUiLanguage } from '@craft-agent/shared/config'

/**
 * Apply the persisted UI language to the main-process i18n instance.
 * Resolves to the applied code, or `undefined` when nothing is persisted — in
 * that case `changeLanguage` is never called and i18n stays on its fallback.
 */
export async function hydrateMainI18nFromPreferences(): Promise<LanguageCode | undefined> {
  const persisted = getPersistedUiLanguage()
  if (!persisted) return undefined
  await i18n.changeLanguage(persisted)
  return persisted
}

/**
 * Persist and apply a language coming from Appearance → Language. Returns
 * `false` for a code outside the supported set: the value is neither written
 * nor applied.
 */
export async function applyUiLanguageChange(lang: string): Promise<boolean> {
  // `find` over the supported set both validates and narrows to LanguageCode.
  const code = SUPPORTED_LANGUAGE_CODES.find((supported) => supported === lang)
  if (!code) return false
  setPersistedUiLanguage(code)
  await i18n.changeLanguage(code)
  return true
}
