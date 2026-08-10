/**
 * turn-card-shared.ts
 *
 * Leaf module for the TurnCard family: shared value/size config, the activity
 * and response value types, and the expansion controller contract.
 *
 * This module imports nothing from TurnCard.tsx / activity-tree.tsx /
 * response-card.tsx, so those files can all depend on it without a runtime
 * import cycle.
 */

import type { AnnotationV1, ToolDisplayMeta } from '@craft-agent/core'

// ============================================================================
// Size Configuration
// ============================================================================

/**
 * Global size configuration for TurnCard components.
 * Adjust these values to scale the entire component uniformly.
 * Shared size configuration for activity UI - exported for reuse in inline execution.
 */
export const SIZE_CONFIG = {
  /** Base font size class for all text */
  fontSize: 'text-[13px]',
  /** Icon size class (width and height) */
  iconSize: 'size-3',
  /** Spinner text size class */
  spinnerSize: 'text-[10px]',
  /** Small spinner for header */
  spinnerSizeSmall: 'text-[8px]',
  /** Activity row height in pixels (approx for calculation) */
  activityRowHeight: 24,
  /** Max visible activities before scrolling (show ~15 items) */
  maxVisibleActivities: 15,
  /** Number of items before which we apply staggered animation */
  staggeredAnimationLimit: 10,
} as const

// ============================================================================
// Types
// ============================================================================

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded'
export type ActivityType = 'tool' | 'thinking' | 'intermediate' | 'status' | 'plan'
export type AnnotationInteractionMode = 'interactive' | 'tooltip-only'

// ============================================================================
// Todo Types (for TodoWrite tool visualization)
// ============================================================================

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

export interface TodoItem {
  /** Task content/description */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form shown when in_progress (e.g., "Running tests") */
  activeForm?: string
}

export interface ActivityItem {
  id: string
  type: ActivityType
  status: ActivityStatus
  toolName?: string
  toolUseId?: string  // For matching parent-child relationships
  toolInput?: Record<string, unknown>
  content?: string
  intent?: string
  /** Optional backing message id (used by plan activities for branching/annotations) */
  messageId?: string
  /** Optional persisted annotations (used by plan activities) */
  annotations?: AnnotationV1[]
  displayName?: string  // LLM-generated human-friendly tool name (for MCP tools)
  toolDisplayMeta?: ToolDisplayMeta  // Embedded metadata with base64 icon (for viewer compatibility)
  timestamp: number
  error?: string
  // Parent-child nesting for Task subagents
  parentId?: string  // Parent activity's toolUseId
  depth?: number     // Nesting level (0 = root, 1 = child, etc.)
  // Status activities (e.g., compacting)
  statusType?: string  // e.g., 'compacting'
  // Background task fields
  taskId?: string         // For background Task tools
  shellId?: string        // For background Bash shells
  elapsedSeconds?: number // Live progress updates
  isBackground?: boolean  // Flag for UI differentiation
}

export interface ResponseContent {
  text: string
  isStreaming: boolean
  streamStartTime?: number
  /** Whether this response is a plan (renders with plan variant) */
  isPlan?: boolean
  /** ID of the underlying message (for branching + annotations) */
  messageId?: string
  /** Persisted annotations attached to the response message */
  annotations?: AnnotationV1[]
}

export type OpenAnnotationRequest = {
  messageId: string
  annotationId: string
  mode: 'view' | 'edit'
  anchorX?: number
  anchorY?: number
  nonce: number
}

// ============================================================================
// Expansion controller contract
// ============================================================================

/**
 * Resolved, single-polarity expansion controller for activity groups.
 *
 * The projection home resolves the `autoExpand` default flip once and exposes
 * plain booleans through this interface, so no downstream component ever
 * re-derives the inverted-set semantics again. `isExpanded` returns the final
 * answer; `setExpanded` records the user's intent for that id.
 */
export interface GroupExpansionController {
  isExpanded: (groupId: string) => boolean
  setExpanded: (groupId: string, expanded: boolean) => void
}
