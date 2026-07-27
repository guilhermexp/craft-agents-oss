/**
 * Session selection hooks.
 *
 * Re-exports the generic useEntitySelection factory hooks for sessions.
 * `useSession` now means session data only (see context/AppShellContext);
 * session selection lives here as `useSessionSelection`.
 */

import { sessionSelection } from './useEntitySelection'

// Re-export factory-generated hooks under existing names
export const useSessionSelection = sessionSelection.useSelection
export const useSessionSelectionStore = sessionSelection.useSelectionStore
export const useIsMultiSelectActive = sessionSelection.useIsMultiSelectActive
export const useSelectedIds = sessionSelection.useSelectedIds
export const useSelectionCount = sessionSelection.useSelectionCount
