/**
 * useBrowserProfiles
 *
 * React hook for the browser profile list and picker preferences.
 * Subscribes to PROFILES_CHANGED so all open windows stay in sync after
 * a profile is created, renamed, or deleted from any of them.
 */

import { useCallback, useEffect, useState } from 'react'
import type { BrowserProfile, BrowserProfileSettings } from '@craft-agent/shared/config/types'

export interface UseBrowserProfilesResult {
  profiles: BrowserProfile[]
  lastUsedProfileId: string
  alwaysAsk: boolean
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  createProfile: (input: { name: string; color: string; avatar?: string }) => Promise<BrowserProfile>
  renameProfile: (id: string, name: string) => Promise<BrowserProfile>
  deleteProfile: (id: string) => Promise<void>
  setAlwaysAsk: (alwaysAsk: boolean) => Promise<void>
  setLastUsedProfileId: (id: string) => Promise<void>
}

const EMPTY_SETTINGS: BrowserProfileSettings = {
  profiles: [],
  lastUsedProfileId: 'default',
  alwaysAsk: false,
}

export function useBrowserProfiles(): UseBrowserProfilesResult {
  const [settings, setSettings] = useState<BrowserProfileSettings>(EMPTY_SETTINGS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const next = await window.electronAPI.browserPane.getProfileSettings()
      setSettings(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsub = window.electronAPI.browserPane.onProfilesChanged((next) => {
      setSettings(next)
    })
    return () => unsub()
  }, [refresh])

  const createProfile = useCallback(
    async (input: { name: string; color: string; avatar?: string }) => {
      return window.electronAPI.browserPane.createProfile(input)
    },
    [],
  )

  const renameProfile = useCallback(async (id: string, name: string) => {
    return window.electronAPI.browserPane.renameProfile({ id, name })
  }, [])

  const deleteProfile = useCallback(async (id: string) => {
    await window.electronAPI.browserPane.deleteProfile(id)
  }, [])

  const setAlwaysAsk = useCallback(async (alwaysAsk: boolean) => {
    await window.electronAPI.browserPane.setProfileSettings({ alwaysAsk })
  }, [])

  const setLastUsedProfileId = useCallback(async (id: string) => {
    await window.electronAPI.browserPane.setProfileSettings({ lastUsedProfileId: id })
  }, [])

  return {
    profiles: settings.profiles,
    lastUsedProfileId: settings.lastUsedProfileId,
    alwaysAsk: settings.alwaysAsk,
    isLoading,
    error,
    refresh,
    createProfile,
    renameProfile,
    deleteProfile,
    setAlwaysAsk,
    setLastUsedProfileId,
  }
}
