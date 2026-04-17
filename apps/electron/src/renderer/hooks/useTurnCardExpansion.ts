/**
 * Hook for persisting TurnCard expanded/collapsed state across session switches.
 *
 * Stores per-session expansion state in a single localStorage key as a bounded
 * LRU map (max 100 sessions). Tracks two sets per session:
 *   - `turns` / `groups` — IDs the user explicitly EXPANDED (used when
 *     autoExpand is off, the historical default).
 *   - `collapsedTurns` / `collapsedGroups` — IDs the user explicitly COLLAPSED
 *     (used when autoExpand is on, so they survive when the user later flips
 *     the global toggle off and back on).
 *
 * Shape:
 *   {
 *     [sessionId]: {
 *       turns: string[],
 *       groups: string[],
 *       collapsedTurns?: string[],
 *       collapsedGroups?: string[],
 *       lastAccessed: number
 *     }
 *   }
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import * as storage from '@/lib/local-storage'

const MAX_SESSIONS = 100

/** Entry for a single session's expansion state */
interface ExpansionEntry {
  turns: string[]
  groups: string[]
  collapsedTurns?: string[]
  collapsedGroups?: string[]
  lastAccessed: number
}

/** Full map stored in localStorage */
type ExpansionMap = Record<string, ExpansionEntry>

function readMap(): ExpansionMap {
  return storage.get<ExpansionMap>(storage.KEYS.turnCardExpansion, {})
}

function writeMap(map: ExpansionMap): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_SESSIONS) {
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
    const pruned: ExpansionMap = {}
    const keep = entries.slice(entries.length - MAX_SESSIONS)
    for (const [key, value] of keep) {
      pruned[key] = value
    }
    storage.set(storage.KEYS.turnCardExpansion, pruned)
  } else {
    storage.set(storage.KEYS.turnCardExpansion, map)
  }
}

function loadEntrySets(sessionId: string | undefined) {
  if (!sessionId) {
    return {
      turns: new Set<string>(),
      groups: new Set<string>(),
      collapsedTurns: new Set<string>(),
      collapsedGroups: new Set<string>(),
    }
  }
  const entry = readMap()[sessionId]
  return {
    turns: new Set<string>(entry?.turns ?? []),
    groups: new Set<string>(entry?.groups ?? []),
    collapsedTurns: new Set<string>(entry?.collapsedTurns ?? []),
    collapsedGroups: new Set<string>(entry?.collapsedGroups ?? []),
  }
}

/**
 * Persist TurnCard expansion state for the given session.
 *
 * `autoExpand` flips the default: when true, every TurnCard / activity group is
 * expanded unless the user explicitly collapsed it; when false (legacy
 * behavior), everything is collapsed unless explicitly expanded.
 *
 * The two sets are tracked independently so toggling the global preference
 * preserves prior user intent in both modes.
 */
export function useTurnCardExpansion(sessionId: string | undefined, autoExpand: boolean) {
  const initial = loadEntrySets(sessionId)

  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(initial.turns)
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(initial.collapsedTurns)
  const [userExpandedGroups, setUserExpandedGroups] = useState<Set<string>>(initial.groups)
  const [userCollapsedGroups, setUserCollapsedGroups] = useState<Set<string>>(initial.collapsedGroups)

  const prevSessionIdRef = useRef(sessionId)

  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return
    const next = loadEntrySets(sessionId)
    setExpandedTurns(next.turns)
    setCollapsedTurns(next.collapsedTurns)
    setUserExpandedGroups(next.groups)
    setUserCollapsedGroups(next.collapsedGroups)
    prevSessionIdRef.current = sessionId
  }, [sessionId])

  // Persist on change. We mirror state into refs so the writer effect always
  // sees the latest value without causing extra renders.
  const refs = useRef({ expandedTurns, collapsedTurns, userExpandedGroups, userCollapsedGroups })
  refs.current = { expandedTurns, collapsedTurns, userExpandedGroups, userCollapsedGroups }

  useEffect(() => {
    if (!sessionId) return
    const map = readMap()
    const turns = [...refs.current.expandedTurns]
    const groups = [...refs.current.userExpandedGroups]
    const collTurns = [...refs.current.collapsedTurns]
    const collGroups = [...refs.current.userCollapsedGroups]

    const empty = turns.length === 0 && groups.length === 0 && collTurns.length === 0 && collGroups.length === 0
    if (empty) {
      if (map[sessionId]) {
        delete map[sessionId]
        writeMap(map)
      }
      return
    }

    map[sessionId] = {
      turns,
      groups,
      collapsedTurns: collTurns.length > 0 ? collTurns : undefined,
      collapsedGroups: collGroups.length > 0 ? collGroups : undefined,
      lastAccessed: Date.now(),
    }
    writeMap(map)
  }, [sessionId, expandedTurns, collapsedTurns, userExpandedGroups, userCollapsedGroups])

  const isTurnExpanded = useCallback(
    (turnId: string): boolean =>
      autoExpand ? !collapsedTurns.has(turnId) : expandedTurns.has(turnId),
    [autoExpand, expandedTurns, collapsedTurns],
  )

  const toggleTurn = useCallback(
    (turnId: string, expanded: boolean) => {
      if (autoExpand) {
        setCollapsedTurns(prev => {
          const next = new Set(prev)
          if (expanded) next.delete(turnId)
          else next.add(turnId)
          return next
        })
      } else {
        setExpandedTurns(prev => {
          const next = new Set(prev)
          if (expanded) next.add(turnId)
          else next.delete(turnId)
          return next
        })
      }
    },
    [autoExpand],
  )

  // The Set passed to TurnCard always represents "user override from default"
  // for the current mode: collapsed-IDs when autoExpand is on, expanded-IDs
  // when autoExpand is off. TurnCard receives `autoExpand` to interpret it.
  const expandedActivityGroups = useMemo(
    () => (autoExpand ? userCollapsedGroups : userExpandedGroups),
    [autoExpand, userCollapsedGroups, userExpandedGroups],
  )

  const setExpandedActivityGroups = useMemo<React.Dispatch<React.SetStateAction<Set<string>>>>(
    () => (autoExpand ? setUserCollapsedGroups : setUserExpandedGroups),
    [autoExpand],
  )

  return {
    isTurnExpanded,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  }
}
