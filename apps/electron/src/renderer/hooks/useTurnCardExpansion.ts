/**
 * Hook for persisting TurnCard expanded/collapsed state across session switches.
 *
 * Stores per-session expansion state in a single localStorage key as a bounded
 * LRU map (max 100 sessions). Each axis (turns, groups) keeps two override sets:
 *   - `expanded` — ids the user explicitly EXPANDED (active when autoExpand is
 *     off, the historical default).
 *   - `collapsed` — ids the user explicitly COLLAPSED (active when autoExpand is
 *     on, so they survive flipping the global toggle off and back on).
 *
 * The `autoExpand` polarity is resolved once, here, via the `turn-expansion`
 * helpers (`isIdExpanded` / `applyExpansionToggle`, imported from
 * `@craft-agent/ui`), so callers receive plain booleans and never re-derive
 * the inverted-set semantics.
 *
 * Persisted shape:
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
import {
  isIdExpanded,
  applyExpansionToggle,
  type ExpansionState,
  type GroupExpansionController,
} from '@craft-agent/ui'

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

/**
 * Legacy expansion ids used the `assistant:msg:<id>` / `assistant:turn:<...>`
 * scheme; the current identity is `turn-<turnId>-<timestamp>` (getTurnKey). The
 * localStorage key and schema are unchanged, so old entries linger with ids that
 * no current turn can ever match. Drop them on load: this both prevents the
 * one-time expand/collapse flip on upgrade AND lets the orphaned entry hit the
 * `empty` branch so the LRU can evict it instead of renewing dead weight.
 */
function dropLegacyIds(ids: string[] | undefined): string[] {
  return (ids ?? []).filter(id => !id.startsWith('assistant:'))
}

function loadEntry(sessionId: string | undefined): { turns: ExpansionState; groups: ExpansionState } {
  const entry = sessionId ? readMap()[sessionId] : undefined
  return {
    turns: {
      expanded: new Set<string>(dropLegacyIds(entry?.turns)),
      collapsed: new Set<string>(dropLegacyIds(entry?.collapsedTurns)),
    },
    groups: {
      expanded: new Set<string>(dropLegacyIds(entry?.groups)),
      collapsed: new Set<string>(dropLegacyIds(entry?.collapsedGroups)),
    },
  }
}

export interface TurnCardExpansion {
  /** Resolved boolean: is this turn currently expanded? */
  isTurnExpanded: (turnId: string) => boolean
  /** Record the user's expand/collapse intent for a turn. */
  toggleTurn: (turnId: string, expanded: boolean) => void
  /** Resolved, single-polarity controller for activity-group expansion. */
  groupExpansion: GroupExpansionController
}

/**
 * Persist TurnCard expansion state for the given session.
 *
 * `autoExpand` flips the default: when true, every turn / activity group is
 * expanded unless the user explicitly collapsed it; when false (legacy
 * behavior), everything is collapsed unless explicitly expanded.
 */
export function useTurnCardExpansion(sessionId: string | undefined, autoExpand: boolean): TurnCardExpansion {
  const initial = loadEntry(sessionId)

  const [turnState, setTurnState] = useState<ExpansionState>(initial.turns)
  const [groupState, setGroupState] = useState<ExpansionState>(initial.groups)

  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return
    const next = loadEntry(sessionId)
    setTurnState(next.turns)
    setGroupState(next.groups)
    prevSessionIdRef.current = sessionId
  }, [sessionId])

  // Mirror state into a ref so the writer effect always sees the latest value
  // without causing extra renders.
  const refs = useRef({ turnState, groupState })
  useEffect(() => {
    refs.current = { turnState, groupState }
  })

  useEffect(() => {
    if (!sessionId) return
    const map = readMap()
    const turns = [...refs.current.turnState.expanded]
    const groups = [...refs.current.groupState.expanded]
    const collapsedTurns = [...refs.current.turnState.collapsed]
    const collapsedGroups = [...refs.current.groupState.collapsed]

    const empty = turns.length === 0 && groups.length === 0 && collapsedTurns.length === 0 && collapsedGroups.length === 0
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
      collapsedTurns: collapsedTurns.length > 0 ? collapsedTurns : undefined,
      collapsedGroups: collapsedGroups.length > 0 ? collapsedGroups : undefined,
      lastAccessed: Date.now(),
    }
    writeMap(map)
  }, [sessionId, turnState, groupState])

  const isTurnExpanded = useCallback(
    (turnId: string): boolean => isIdExpanded(turnState, autoExpand, turnId),
    [turnState, autoExpand],
  )

  const toggleTurn = useCallback(
    (turnId: string, expanded: boolean) =>
      setTurnState(prev => applyExpansionToggle(prev, autoExpand, turnId, expanded)),
    [autoExpand],
  )

  const groupExpansion = useMemo<GroupExpansionController>(
    () => ({
      isExpanded: (groupId: string) => isIdExpanded(groupState, autoExpand, groupId),
      setExpanded: (groupId: string, expanded: boolean) =>
        setGroupState(prev => applyExpansionToggle(prev, autoExpand, groupId, expanded)),
    }),
    [groupState, autoExpand],
  )

  return { isTurnExpanded, toggleTurn, groupExpansion }
}
