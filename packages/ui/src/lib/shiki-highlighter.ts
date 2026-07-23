/**
 * Shared Shiki highlighter with on-demand (lazy) grammar + theme loading.
 *
 * Built on `shiki/core` instead of the `shiki` full bundle so the initial
 * renderer bundle does not eagerly pull the highlighting engine's shorthand
 * machinery. Each language grammar and theme is dynamically imported the first
 * time it is actually rendered (`bundledLanguages[lang]()` / `bundledThemes[theme]()`
 * are code-split by the bundler), so exotic languages (cpp, wasm, wolfram, …)
 * still highlight — their grammar is fetched on first use rather than shipped in
 * the entry chunk. A single core highlighter instance is reused across the app
 * and remembers what it has already loaded.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes, type BundledTheme } from 'shiki/themes'

const DEFAULT_THEME: BundledTheme = 'github-dark'
const PLAINTEXT_LANG = 'text'

let highlighterPromise: Promise<HighlighterCore> | null = null
// Dynamic membership tracking of what the singleton highlighter has already
// loaded, so a repeated render does not re-trigger the grammar/theme import.
const loadedLanguages = new Set<string>()
const loadedThemes = new Set<string>()

function getCoreHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      // WASM engine is itself lazily imported.
      engine: createOnigurumaEngine(() => import('shiki/wasm')),
      langs: [],
      themes: [],
    })
  }
  return highlighterPromise
}

/** True when `lang` maps to a Shiki bundled grammar loadable on demand. */
export function isBundledLanguage(lang: string): lang is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, lang)
}

/** True when `theme` maps to a Shiki bundled theme loadable on demand. */
export function isBundledTheme(theme: string): theme is BundledTheme {
  return Object.prototype.hasOwnProperty.call(bundledThemes, theme)
}

async function ensureThemeLoaded(highlighter: HighlighterCore, theme: BundledTheme): Promise<void> {
  if (loadedThemes.has(theme)) return
  await highlighter.loadTheme(bundledThemes[theme])
  loadedThemes.add(theme)
}

async function ensureLanguageLoaded(highlighter: HighlighterCore, lang: BundledLanguage): Promise<void> {
  if (loadedLanguages.has(lang)) return
  await highlighter.loadLanguage(bundledLanguages[lang])
  loadedLanguages.add(lang)
}

/**
 * Highlight `code` to HTML, lazily loading the grammar for `lang` and the
 * `theme` on first use. Unknown languages fall back to plaintext and unknown
 * themes fall back to a safe default, so callers never crash on an unsupported
 * identifier.
 */
export async function highlightCodeToHtml(code: string, lang: string, theme: string): Promise<string> {
  const highlighter = await getCoreHighlighter()
  const resolvedTheme: BundledTheme = isBundledTheme(theme) ? theme : DEFAULT_THEME
  await ensureThemeLoaded(highlighter, resolvedTheme)

  const resolvedLang: BundledLanguage | typeof PLAINTEXT_LANG = isBundledLanguage(lang)
    ? lang
    : PLAINTEXT_LANG
  if (resolvedLang !== PLAINTEXT_LANG) {
    await ensureLanguageLoaded(highlighter, resolvedLang)
  }

  return highlighter.codeToHtml(code, { lang: resolvedLang, theme: resolvedTheme })
}
