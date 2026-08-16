/**
 * Mounts the perf overlay into its own React root.
 *
 * Separate root, not a component inside `AppShell`, for two reasons:
 * the overlay updates every second and must not schedule work in the tree it
 * measures, and its own commits must not appear in the commit table. The root's
 * container is registered with the commit tracker so those commits are skipped.
 *
 * No `StrictMode`: the app's double-invoke is a property of what we measure,
 * not of the measuring surface.
 */

import { createRoot, type Root } from 'react-dom/client'
import { ignoreCommitContainer } from '../../lib/perf/react-commits'
import { PerfOverlay } from './PerfOverlay'

const CONTAINER_ID = 'craft-perf-overlay'

let root: Root | null = null

export function mountPerfOverlay(): void {
  if (root) return

  const container = document.createElement('div')
  container.id = CONTAINER_ID
  document.body.appendChild(container)

  ignoreCommitContainer(container)
  root = createRoot(container)
  root.render(<PerfOverlay />)
}
