import { useState, useEffect, useCallback } from 'react'
import type { ChannelConfig } from '@craft-agent/shared/channels'

export interface UseChannelsResult {
  channels: ChannelConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useChannels(workspaceId: string | null): UseChannelsResult {
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setChannels([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const configs = await window.electronAPI.listChannels(workspaceId)
      setChannels(configs)
      setError(null)
    } catch (err) {
      console.error('[useChannels] Failed to load channels:', err)
      setError(err instanceof Error ? err.message : 'Failed to load channels')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onChannelsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return { channels, isLoading, error, refresh }
}
