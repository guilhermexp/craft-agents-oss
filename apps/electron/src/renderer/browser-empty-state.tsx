import React, { useCallback } from 'react'
import { initReactI18next, useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import ReactDOM from 'react-dom/client'
import { BrowserEmptyStateCard } from '@craft-agent/ui'
import { setupI18n } from '@craft-agent/shared/i18n'
import { routes } from '../shared/routes'
import { EMPTY_STATE_PROMPT_SAMPLES } from './components/browser/empty-state-prompts'
import { BROWSER_CHROME_BG } from '../shared/browser-chrome'
import './index.css'

// Initialize i18n before any React rendering — this entry runs in its own
// renderer (BrowserView) and does not share state with the main app shell.
setupI18n([LanguageDetector, initReactI18next])

// The new-tab page is browser chrome, not app canvas. Rebasing `--background`
// makes every derived surface token (cards, borders, muted fills) resolve
// against the colour the native window already paints, instead of the app's
// near-black canvas — which is what made the page read as a hole punched in
// the browser. Set inline so it beats the stylesheet regardless of load order.
document.documentElement.style.setProperty(
  '--background',
  BROWSER_CHROME_BG[window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'],
)

function BrowserEmptyStateApp() {
  const { t } = useTranslation()
  const handlePromptSelect = useCallback(async (fullPrompt: string) => {
    const route = routes.action.newSession({ input: fullPrompt, send: true })
    const token = String(Date.now())

    try {
      if (window.electronAPI?.browserPane?.emptyStateLaunch) {
        await window.electronAPI.browserPane.emptyStateLaunch({ route, token })
        return
      }
    } catch {
      // Fallback to hash-signaling below if IPC route fails for any reason.
    }

    const launchParams = new URLSearchParams({ route, ts: token })
    window.location.hash = `launch=${launchParams.toString()}`
  }, [])

  return (
    <div className="h-dvh w-screen bg-background overflow-hidden">
      <div className="h-full w-full overflow-auto">
        <BrowserEmptyStateCard
          title={t("browser.readyTitle")}
          description={t("browser.readyDescription")}
          prompts={EMPTY_STATE_PROMPT_SAMPLES}
          showExamplePrompts={true}
          showSafetyHint={true}
          onPromptSelect={(sample) => handlePromptSelect(sample.full)}
        />
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserEmptyStateApp />
  </React.StrictMode>,
)
