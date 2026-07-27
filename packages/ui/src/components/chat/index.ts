/**
 * Chat component exports for @craft-agent/ui
 */

// Turn utilities (pure functions, no React)
export * from './turn-utils'
export * from './follow-up-helpers'

// Components
export { TurnCard, type TurnCardProps } from './TurnCard'
export { ResponseCard, type ResponseCardProps } from './response-card'
export { ActivityStatusIcon } from './activity-tree'
export {
  SIZE_CONFIG,
  type ActivityItem,
  type ActivityStatus,
  type ActivityType,
  type ResponseContent,
  type TodoItem,
  type TodoStatus,
  type AnnotationInteractionMode,
  type OpenAnnotationRequest,
  type GroupExpansionController,
} from './turn-card-shared'
export { isIdExpanded, applyExpansionToggle, type ExpansionState } from './turn-expansion'
export { InlineExecution, mapToolEventToActivity, type InlineExecutionProps, type InlineExecutionStatus, type InlineActivityItem } from './InlineExecution'
export { TurnCardActionsMenu, type TurnCardActionsMenuProps } from './TurnCardActionsMenu'
export { SessionViewer, type SessionViewerProps, type SessionViewerMode } from './SessionViewer'
export { UserMessageBubble, type UserMessageBubbleProps } from './UserMessageBubble'
export { SystemMessage, type SystemMessageProps, type SystemMessageType } from './SystemMessage'

// Attachment helpers
export { FileTypeIcon, getFileTypeLabel, type FileTypeIconProps } from './attachment-helpers'

// Accept plan dropdown (for plan cards)
export { AcceptPlanDropdown } from './AcceptPlanDropdown'
