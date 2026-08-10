/**
 * AutomationsContext
 *
 * Dedicated seam for automation management: the test/toggle/duplicate/delete/replay
 * callbacks, history fetch, and the last-test-result cache produced by useAutomations.
 *
 * These previously rode on the AppShell context bag even though only the automations
 * surface consumes them (MainContentPanel → AutomationInfoPage, plus the automations
 * navigator in AppShell). AppShell owns the single useAutomations() instance and
 * provides it here so the navigator and the info page share one test-result cache
 * (automationTestResults is local state, not a Jotai atom — two instances would drift).
 */

import { createContext, useContext } from 'react'
import type { UseAutomationsResult } from '@/hooks/useAutomations'

const AutomationsContext = createContext<UseAutomationsResult | null>(null)

export const AutomationsProvider = AutomationsContext.Provider

/** Automation callbacks + last-test-result cache from the single useAutomations instance. */
export function useAutomationsContext(): UseAutomationsResult {
  const context = useContext(AutomationsContext)
  if (!context) {
    throw new Error('useAutomationsContext must be used within an AutomationsProvider')
  }
  return context
}
