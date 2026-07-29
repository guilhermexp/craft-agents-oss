import * as React from 'react'
import { useTranslation } from "react-i18next"
import { ChevronDown, Square, ArrowUpRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { BackgroundTask, BackgroundTaskStatus } from '@/atoms/sessions'

/** Terminal data for overlay display */
export interface TerminalOverlayData {
  command: string
  output: string
  description?: string
  toolType: 'bash' | 'grep' | 'glob'
}

/** Format elapsed time in a compact way */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/** Shorten task ID for compact display (show first 8 chars) */
function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

const TASK_TYPE_LABEL_KEY: Record<BackgroundTask['type'], string> = {
  agent: 'chat.taskTypeAgent',
  shell: 'chat.taskTypeShell',
  workflow: 'chat.taskTypeWorkflow',
  'team-task': 'chat.taskTypeTeamTask',
}

const TERMINAL_STATUS_LABEL_KEY: Record<Exclude<BackgroundTaskStatus, 'running'>, string> = {
  completed: 'chat.taskStatusDone',
  failed: 'chat.taskStatusFailed',
  stopped: 'chat.taskStatusStopped',
  orphaned: 'chat.taskStatusOrphaned',
}

export interface TaskActionMenuProps {
  /** Background task data */
  task: BackgroundTask
  /** Session ID for opening preview windows */
  sessionId: string
  /** Callback when kill button is clicked */
  onKillTask: (taskId: string) => void
  /** Callback to insert message into input field */
  onInsertMessage?: (text: string) => void
  /** Callback to show terminal output overlay */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** Additional class name */
  className?: string
}

/**
 * TaskActionMenu - Dropdown menu for background task actions
 *
 * Provides contextual actions for background tasks:
 * - View Output: Opens task output in terminal overlay
 * - Stop Task: Kills shell tasks (agent tasks show warning)
 */
export function TaskActionMenu({ task, sessionId, onKillTask, onInsertMessage, onShowTerminalOverlay, className }: TaskActionMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  // Wall-clock fallback keeps tasks without progress events (team tasks and
  // async agents) moving, then freezes at their terminal timestamp.
  const [localElapsed, setLocalElapsed] = React.useState(() =>
    Math.max(0, Math.floor(((task.completedAt ?? Date.now()) - task.startTime) / 1000)))

  React.useEffect(() => {
    if (task.status !== 'running') return

    const interval = setInterval(() => {
      setLocalElapsed(Math.max(0, Math.floor((Date.now() - task.startTime) / 1000)))
    }, 1000)

    return () => clearInterval(interval)
  }, [task.status, task.startTime])

  const terminalElapsed = Math.max(
    0,
    Math.floor(((task.completedAt ?? Date.now()) - task.startTime) / 1000),
  )
  const displayElapsed = Math.max(
    task.elapsedSeconds,
    task.status === 'running' ? localElapsed : terminalElapsed,
  )
  const statusLabel = task.status === 'running'
    ? task.isIdle
      ? t('chat.taskStatusIdle')
      : null
    : t(TERMINAL_STATUS_LABEL_KEY[task.status])
  const workflowProgress = task.type === 'workflow' && (task.agentsCompleted ?? 0) > 0
    ? t('chat.workflowAgentsDone', { count: task.agentsCompleted })
    : null

  const handleViewOutput = async () => {
    if (!onShowTerminalOverlay) {
      toast.error(t('toast.terminalOverlayNotAvailable'))
      return
    }

    try {
      // Workflow completion may be keyed by either its wf_ run id or returned
      // task id. Prefer wf_, then fall back to the returned id.
      const outputTaskId = task.type === 'workflow' ? task.workflowId ?? task.id : task.id
      let output = await window.electronAPI.getTaskOutput(outputTaskId)
      if (!output && outputTaskId !== task.id) {
        output = await window.electronAPI.getTaskOutput(task.id)
      }
      // Show terminal output in overlay
      onShowTerminalOverlay({
        command: task.intent || `${task.type} task`,
        output: output || t('chat.noOutputYet'),
        description: task.intent,
        toolType: 'bash', // Use 'bash' for both shell and agent tasks
      })
      setOpen(false)
    } catch (err) {
      toast.error(t('toast.failedToLoadTaskOutput'))
    }
  }

  const handleStopTask = () => {
    onKillTask(task.id)
    setOpen(false)
  }

  const hasActions = task.type !== 'team-task'


  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!hasActions}
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px]",
            "flex items-center gap-1.5 shrink-0 select-none",
            "transition-all shadow-minimal",
            hasActions ? "cursor-pointer" : "cursor-default",
            // Plain white badge with hover
            "bg-white dark:bg-white/10",
            hasActions
              ? "hover:bg-white/80 dark:hover:bg-white/15 data-[state=open]:bg-white/80 dark:data-[state=open]:bg-white/15"
              : "",
            className
          )}
          title={hasActions ? t("chat.clickForTaskActions") : undefined}
        >
          {task.status === 'running' && !task.isIdle ? (
            <div className="flex items-center justify-center shrink-0">
              <Spinner className="text-xs" />
            </div>
          ) : null}

          <span className="opacity-60">
            {t(TASK_TYPE_LABEL_KEY[task.type])}
          </span>

          {task.agentName ? (
            <span className="font-medium opacity-80">
              {task.agentName}
            </span>
          ) : null}

          <span className={cn("max-w-48 truncate opacity-80", task.intent ? "" : "font-mono")}>
            {task.intent ?? shortenId(task.id)}
          </span>

          {workflowProgress ? <span className="opacity-60">{workflowProgress}</span> : null}
          {statusLabel ? <span className="opacity-60">{statusLabel}</span> : null}

          <span className="opacity-60 tabular-nums">
            {formatElapsed(displayElapsed)}
          </span>

          {/* Dropdown indicator */}
          <ChevronDown className="size-3.5 opacity-60 ml-auto" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" sideOffset={4}>
        {/* View Output - Primary action */}
        <StyledDropdownMenuItem onClick={handleViewOutput}>
          <ArrowUpRight />
          {t('chat.viewOutput')}
        </StyledDropdownMenuItem>

        {/* Stop Task - Only show for shell tasks (inserts kill command into input) */}
        {task.type === 'shell' && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleStopTask}>
              <Square />
              {t('chat.stopTask')}
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
