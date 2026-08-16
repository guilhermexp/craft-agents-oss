/**
 * useTurnProjection - the home for Turn projection.
 *
 * Groups a session's messages into turns exactly once per render, keeps the
 * resulting Turn[] structurally shared across streaming re-renders (so completed
 * TurnCards skip re-render on every token), and exposes the single Turn identity
 * plus the resolved expansion controllers. Search and render both consume the
 * same cached turns instead of regrouping.
 *
 * Expansion is resolved here too, but its auto-expand window is per turn, so the
 * controllers take the turn's in-flight state (`!isComplete`) at the call site.
 */

import { useMemo, useRef, useLayoutEffect } from 'react'
import { groupMessagesByTurn, reconcileTurns, getTurnKey, type Turn } from '@craft-agent/ui'
import type { Message } from '../../shared/types'
import { useAutoExpandActivities } from './useAutoExpandActivities'
import { useTurnCardExpansion, type TurnCardExpansion } from './useTurnCardExpansion'

export interface TurnProjection extends TurnCardExpansion {
  /** Reconciled turns for the session (structural sharing preserved across streaming). */
  turns: Turn[]
  /** The single Turn identity used for React keys, refs, search match ids and expansion. */
  getTurnKey: (turn: Turn) => string
}

export interface UseTurnProjectionOptions {
  sessionId: string | undefined
  messages: Message[] | undefined
  isProcessing: boolean | undefined
}

export function useTurnProjection({ sessionId, messages, isProcessing }: UseTurnProjectionOptions): TurnProjection {
  const autoExpand = useAutoExpandActivities()
  const expansion = useTurnCardExpansion(sessionId, autoExpand)

  // Structural-sharing cache. Updated after commit so aborted/replayed React
  // renders never leak into the cache.
  const cacheRef = useRef<{ sessionId: string | null; turns: Turn[] }>({ sessionId: null, turns: [] })

  const turns = useMemo(() => {
    // Pass isSessionProcessing so a turn that ends on a tool call (no final
    // non-intermediate text) is marked complete once the session stops — avoids
    // the chat sitting on "Thinking…" forever.
    const fresh = groupMessagesByTurn(messages ?? [], { isSessionProcessing: isProcessing })
    // Reuse unchanged turn objects so React.memo on TurnCard skips completed
    // turns on every streaming token. Cache resets on session switch.
    const prev = cacheRef.current.sessionId === (sessionId ?? null) ? cacheRef.current.turns : []
    return reconcileTurns(prev, fresh, getTurnKey)
  }, [messages, isProcessing, sessionId])

  useLayoutEffect(() => {
    cacheRef.current = { sessionId: sessionId ?? null, turns }
  }, [turns, sessionId])

  return { turns, getTurnKey, ...expansion }
}
