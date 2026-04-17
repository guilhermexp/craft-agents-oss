/**
 * Read-only hook for the global "auto-expand chat activities" preference.
 *
 * The value lives in `~/.craft-agent/config.json` and is set from
 * AppearanceSettingsPage. We refetch on window focus so changes made in
 * another window propagate without a reload, and we listen for an in-app
 * `autoExpandActivitiesChanged` event so flips inside the same window are
 * reflected immediately even though the chat and the settings page live on
 * different routes.
 */

import { useEffect, useState } from 'react'

export const AUTO_EXPAND_ACTIVITIES_EVENT = 'autoExpandActivitiesChanged'

export function useAutoExpandActivities(): boolean {
  const [value, setValue] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    const fetchValue = () => {
      window.electronAPI?.getAutoExpandActivities?.().then(v => {
        if (!cancelled) setValue(Boolean(v))
      }).catch(() => { /* ignore — keeps current value */ })
    }

    fetchValue()

    const onFocus = () => fetchValue()
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') setValue(detail)
      else fetchValue()
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener(AUTO_EXPAND_ACTIVITIES_EVENT, onChange)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(AUTO_EXPAND_ACTIVITIES_EVENT, onChange)
    }
  }, [])

  return value
}
