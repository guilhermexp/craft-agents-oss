import type { SessionEvent } from '../../shared/types';
import type { BackgroundTask } from '../atoms/sessions';

export function reduceBackgroundTasks(
  tasks: BackgroundTask[],
  event: SessionEvent,
  now: number,
): BackgroundTask[] {
  switch (event.type) {
    case 'task_backgrounded': {
      const index = tasks.findIndex((task) =>
        task.id === event.taskId || task.toolUseId === event.toolUseId);
      const isWorkflow = event.kind === 'workflow';
      if (index !== -1) {
        return tasks.map((task, taskIndex) => taskIndex === index
          ? {
              ...task,
              type: isWorkflow ? 'workflow' : task.type,
              toolUseId: event.toolUseId,
              intent: event.intent ?? task.intent,
              agentName: event.agentName ?? task.agentName,
              workflowId: event.workflowId ?? task.workflowId,
              ...(isWorkflow && task.agentsCompleted === undefined ? { agentsCompleted: 0 } : {}),
            }
          : task);
      }
      return [...tasks, {
        id: event.taskId,
        type: isWorkflow ? 'workflow' : 'agent',
        toolUseId: event.toolUseId,
        startTime: now,
        elapsedSeconds: 0,
        status: 'running',
        ...(event.intent ? { intent: event.intent } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.workflowId ? { workflowId: event.workflowId } : {}),
        ...(isWorkflow ? { agentsCompleted: 0 } : {}),
      }];
    }

    case 'shell_backgrounded':
      if (tasks.some((task) => task.toolUseId === event.toolUseId)) return tasks;
      return [...tasks, {
        id: event.shellId,
        type: 'shell',
        toolUseId: event.toolUseId,
        startTime: now,
        elapsedSeconds: 0,
        status: 'running',
        ...(event.intent ? { intent: event.intent } : {}),
      }];

    case 'workflow_agent_completed': {
      const index = tasks.findIndex((task) => task.workflowId === event.workflowId);
      if (index === -1) return tasks;
      const existing = tasks[index]!;
      if (existing.completedAgentIds?.includes(event.agentId)) return tasks;
      const completedAgentIds = [...(existing.completedAgentIds ?? []), event.agentId];
      return tasks.map((task, taskIndex) => taskIndex === index
        ? { ...task, completedAgentIds, agentsCompleted: completedAgentIds.length }
        : task);
    }

    case 'team_task_created': {
      const index = tasks.findIndex((task) => task.id === event.taskId && task.type === 'team-task');
      const existing = index === -1 ? undefined : tasks[index];
      const next: BackgroundTask = {
        ...existing,
        id: event.taskId,
        type: 'team-task',
        startTime: existing?.startTime ?? now,
        elapsedSeconds: existing?.elapsedSeconds ?? 0,
        status: existing?.status ?? 'running',
        intent: event.description ?? event.subject,
        agentName: event.teammateName ?? existing?.agentName,
      };
      if (index === -1) return [...tasks, next];
      return tasks.map((task, taskIndex) => taskIndex === index ? next : task);
    }

    case 'team_task_completed': {
      const index = tasks.findIndex((task) => task.id === event.taskId && task.type === 'team-task');
      if (index === -1) {
        return [...tasks, {
          id: event.taskId,
          type: 'team-task',
          startTime: now,
          elapsedSeconds: 0,
          status: 'completed',
          completedAt: now,
          intent: event.subject,
          ...(event.teammateName ? { agentName: event.teammateName } : {}),
        }];
      }
      const existing = tasks[index]!;
      if (existing.status !== 'running') return tasks;
      return tasks.map((task, taskIndex) => taskIndex === index
        ? {
            ...task,
            status: 'completed',
            completedAt: now,
            intent: task.intent ?? event.subject,
            agentName: task.agentName ?? event.teammateName,
          }
        : task);
    }

    case 'teammate_idle': {
      const hasActiveTeammate = tasks.some((task) =>
        task.type === 'agent'
        && task.status === 'running'
        && task.agentName === event.teammateName
        && task.isIdle !== true);
      if (!hasActiveTeammate) return tasks;
      return tasks.map((task) =>
        task.type === 'agent' && task.status === 'running' && task.agentName === event.teammateName
          ? { ...task, isIdle: true }
          : task);
    }

    case 'tool_start': {
      if (event.toolName !== 'SendMessage') return tasks;
      const recipient = typeof event.toolInput.to === 'string' ? event.toolInput.to.trim() : '';
      if (!recipient || !tasks.some((task) => task.agentName === recipient && task.isIdle === true)) return tasks;
      return tasks.map((task) => task.agentName === recipient && task.isIdle === true
        ? { ...task, isIdle: false }
        : task);
    }

    case 'task_progress':
      if (!tasks.some((task) => task.toolUseId === event.toolUseId)) return tasks;
      return tasks.map((task) => task.toolUseId === event.toolUseId
        ? { ...task, elapsedSeconds: event.elapsedSeconds }
        : task);

    case 'task_completed': {
      const index = tasks.findIndex((task) =>
        task.id === event.taskId || task.workflowId === event.taskId);
      if (index === -1) {
        return [...tasks, {
          id: event.taskId,
          type: 'agent',
          startTime: now,
          elapsedSeconds: 0,
          status: event.status,
          completedAt: now,
          ...(event.outputFile ? { outputFile: event.outputFile } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
        }];
      }
      const existing = tasks[index]!;
      return tasks.map((task, taskIndex) => taskIndex === index
        ? {
            ...task,
            status: existing.status === 'running' ? event.status : existing.status,
            completedAt: existing.completedAt ?? now,
            isIdle: false,
            ...(event.outputFile ? { outputFile: event.outputFile } : {}),
            ...(event.summary ? { summary: event.summary } : {}),
          }
        : task);
    }

    case 'shell_killed': {
      const index = tasks.findIndex((task) => task.id === event.shellId && task.type === 'shell');
      if (index === -1 || tasks[index]!.status !== 'running') return tasks;
      return tasks.map((task, taskIndex) => taskIndex === index
        ? { ...task, status: 'stopped', completedAt: now }
        : task);
    }

    case 'tool_result': {
      const isBackgroundingResult = /agentId:\s*[a-zA-Z0-9_-]+/.test(event.result)
        || /shell_id:\s*[a-zA-Z0-9_-]+/.test(event.result)
        || /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/.test(event.result)
        || /Workflow launched in background/i.test(event.result);
      if (isBackgroundingResult || !tasks.some((task) => task.toolUseId === event.toolUseId)) return tasks;
      return tasks.filter((task) => task.toolUseId !== event.toolUseId);
    }

    default:
      return tasks;
  }
}
