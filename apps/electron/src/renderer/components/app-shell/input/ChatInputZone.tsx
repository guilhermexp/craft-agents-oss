import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@craft-agent/shared/labels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { ResolvedSessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { ModelPickerControl } from './ModelPickerControl'

const EMPTY_TASKS: BackgroundTask[] = []
const EMPTY_SESSION_LABELS: string[] = []
const EMPTY_LABELS: LabelConfig[] = []
const EMPTY_SESSION_STATUSES: ResolvedSessionStatus[] = []

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  sessionStatuses?: ResolvedSessionStatus[]
  currentSessionStatus?: string
  onSessionStatusChange?: (stateId: string) => void
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = EMPTY_TASKS,
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  sessionLabels = EMPTY_SESSION_LABELS,
  labels = EMPTY_LABELS,
  onLabelsChange,
  sessionStatuses = EMPTY_SESSION_STATUSES,
  currentSessionStatus = 'todo',
  onSessionStatusChange,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleLabelAdd = React.useCallback((labelId: string) => {
    const current = sessionLabels || []
    if (current.includes(labelId)) return

    onLabelsChange?.([...current, labelId])

    const config = flattenLabels(labels || []).find(label => label.id === labelId)
    if (config?.valueType) {
      setAutoOpenLabelId(labelId)
    }
  }, [labels, onLabelsChange, sessionLabels])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          labels={labels}
          sessionLabels={sessionLabels}
          onLabelAdd={handleLabelAdd}
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
          currentSessionStatus={currentSessionStatus}
        />
      </InputErrorBoundary>

        {!compactMode && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
            {shouldShowOptionBadges && (
            <ActiveOptionBadges
              className="mb-0"
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              tasks={tasks}
              sessionId={sessionId}
              sessionFolderPath={sessionFolderPath}
              onKillTask={onKillTask}
              onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
              sessionLabels={sessionLabels}
              labels={labels}
              onLabelsChange={onLabelsChange}
              onRemoveLabel={(labelId) => {
                const next = (sessionLabels || []).filter(entry => entry !== labelId && !entry.startsWith(`${labelId}::`))
                onLabelsChange?.(next)
              }}
              autoOpenLabelId={autoOpenLabelId}
              onAutoOpenConsumed={() => setAutoOpenLabelId(null)}
              sessionStatuses={sessionStatuses}
              currentSessionStatus={currentSessionStatus}
              onSessionStatusChange={onSessionStatusChange}
            />
            )}
            <ModelPickerControl
              currentModel={inputProps.currentModel}
              onModelChange={inputProps.onModelChange}
              currentConnection={inputProps.currentConnection}
              onConnectionChange={inputProps.onConnectionChange}
              thinkingLevel={inputProps.thinkingLevel}
              onThinkingLevelChange={inputProps.onThinkingLevelChange}
              hermesProfile={inputProps.hermesProfile}
              onHermesProfileChange={inputProps.onHermesProfileChange}
              connectionUnavailable={inputProps.connectionUnavailable}
              isEmptySession={inputProps.isEmptySession}
              contextStatus={inputProps.contextStatus}
            />
          </div>
        )}
    </div>
  )
}
