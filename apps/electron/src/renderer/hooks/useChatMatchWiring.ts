/**
 * useChatMatchWiring
 *
 * Owns the ChatDisplay search-match navigation wiring that AppShell hands to the
 * SessionSearchWiring context seam: the imperative ref, the current match info,
 * and the change handler (memo-guarded against identical updates). Resets the
 * match info whenever tracking is inactive (search closed or query empty).
 */

import * as React from 'react'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'

/** Match info reported by ChatDisplay as the user navigates search hits. */
export interface ChatMatchInfo {
  sessionId: string | null
  count: number
  index: number
  isHighlighting?: boolean
}

export interface ChatMatchWiring {
  chatDisplayRef: React.RefObject<ChatDisplayHandle | null>
  chatMatchInfo: ChatMatchInfo
  onChatMatchInfoChange: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void
}

export function useChatMatchWiring(isTracking: boolean): ChatMatchWiring {
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<ChatMatchInfo>({ sessionId: null, count: 0, index: 0 })

  // Memo guard prevents render feedback loops from identical updates
  const onChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search tracking is inactive
  React.useEffect(() => {
    if (!isTracking) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [isTracking])

  return { chatDisplayRef, chatMatchInfo, onChatMatchInfoChange }
}
