import type { AgentEvent } from '@craft-agent/core/types';
export interface ClaudeTeamLifecycleHookInput {
  hook_event_name: string;
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

export function normalizeClaudeTeamLifecycleHook(input: ClaudeTeamLifecycleHookInput): AgentEvent | null {
  if (input.hook_event_name === 'TeammateIdle') {
    const teammateName = trimmed(input.teammate_name);
    return teammateName ? { type: 'teammate_idle', teammateName } : null;
  }

  if (input.hook_event_name !== 'TaskCreated' && input.hook_event_name !== 'TaskCompleted') {
    return null;
  }

  const taskId = trimmed(input.task_id);
  const subject = trimmed(input.task_subject);
  if (!taskId || !subject) return null;

  const teammateName = trimmed(input.teammate_name);
  if (input.hook_event_name === 'TaskCompleted') {
    return {
      type: 'team_task_completed',
      taskId,
      subject,
      ...(teammateName ? { teammateName } : {}),
    };
  }

  const description = trimmed(input.task_description);
  return {
    type: 'team_task_created',
    taskId,
    subject,
    ...(description ? { description } : {}),
    ...(teammateName ? { teammateName } : {}),
  };
}
