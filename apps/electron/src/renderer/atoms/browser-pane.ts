/**
 * Browser Pane Atoms
 *
 * Jotai atoms for browser instance state in the renderer.
 * Synced from the main process via BROWSER_PANE_STATE_CHANGED IPC events.
 */

import { atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import type { BrowserInstanceInfo } from '../../shared/types'

/** Map of all browser instances by ID */
const browserInstancesMapAtom = atom<Map<string, BrowserInstanceInfo>>(new Map())

/** Derived: array of all browser instances (for iteration) */
export const browserInstancesAtom = selectAtom(
  browserInstancesMapAtom,
  (map) => Array.from(map.values()),
  (a, b) => a.length === b.length && a.every((instance, i) => instance === b[i])
)

/** Derived: count of active browser instances */
const browserInstanceCountAtom = atom<number>(
  (get) => get(browserInstancesMapAtom).size
)

/** Currently active browser instance ID (selected/focused by user interactions) */
export const activeBrowserInstanceIdAtom = atom<string | null>(null)

/**
 * Instance currently shown as a card inside the app, or null when every
 * browser is a separate window. Only one can be integrated at a time: the card
 * is a full-window overlay, and two native views would fight over the same hole.
 */
export const integratedBrowserInstanceIdAtom = atom<string | null>(null)

/** Tombstones for instances removed from renderer state (guards against late out-of-order updates) */
const removedBrowserInstanceIdsAtom = atom<Set<string>>(new Set<string>())

/** Derived: currently active browser instance info */
const activeBrowserInstanceAtom = atom<BrowserInstanceInfo | null>((get) => {
  const activeId = get(activeBrowserInstanceIdAtom)
  if (!activeId) return null
  return get(browserInstancesMapAtom).get(activeId) ?? null
})

/** Update a single browser instance (from IPC state change event) */
export const updateBrowserInstanceAtom = atom(
  null,
  (get, set, info: BrowserInstanceInfo) => {
    const removedIds = get(removedBrowserInstanceIdsAtom)
    if (removedIds.has(info.id)) {
      return
    }

    const map = new Map(get(browserInstancesMapAtom))
    map.set(info.id, info)
    set(browserInstancesMapAtom, map)
  }
)

/** Remove a browser instance (when destroyed) */
export const removeBrowserInstanceAtom = atom(
  null,
  (get, set, id: string) => {
    const map = new Map(get(browserInstancesMapAtom))
    map.delete(id)
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    removedIds.add(id)
    set(removedBrowserInstanceIdsAtom, removedIds)

    // The integrated card is a full-window overlay. If it outlives the instance
    // it points at, the user is left staring at a scrim with nothing behind it
    // and no way back — so the card's lifetime is tied to the instance here.
    if (get(integratedBrowserInstanceIdAtom) === id) {
      set(integratedBrowserInstanceIdAtom, null)
    }
  }
)

/** Set all browser instances at once (from list query) */
export const setBrowserInstancesAtom = atom(
  null,
  (get, set, instances: BrowserInstanceInfo[]) => {
    const map = new Map<string, BrowserInstanceInfo>()
    for (const info of instances) {
      map.set(info.id, info)
    }
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    for (const info of instances) {
      removedIds.delete(info.id)
    }
    set(removedBrowserInstanceIdsAtom, removedIds)
  }
)
