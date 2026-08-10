import { describe, expect, it } from 'bun:test';
import type {
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  TeammateIdleHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { normalizeClaudeTeamLifecycleHook } from './team-lifecycle.ts';

const base = {
  session_id: 'session-1',
  transcript_path: '/tmp/session.jsonl',
  cwd: '/workspace',
} as const;

describe('normalizeClaudeTeamLifecycleHook', () => {
  it('normalizes TaskCreated without the deprecated team name', () => {
    const input: TaskCreatedHookInput = {
      ...base,
      hook_event_name: 'TaskCreated',
      task_id: 'task-1',
      task_subject: 'Review auth',
      task_description: 'Check token refresh',
      teammate_name: 'reviewer',
      team_name: 'ignored',
    };

    expect(normalizeClaudeTeamLifecycleHook(input)).toEqual({
      type: 'team_task_created',
      taskId: 'task-1',
      subject: 'Review auth',
      description: 'Check token refresh',
      teammateName: 'reviewer',
    });
  });

  it('normalizes TaskCompleted', () => {
    const input: TaskCompletedHookInput = {
      ...base,
      hook_event_name: 'TaskCompleted',
      task_id: 'task-1',
      task_subject: 'Review auth',
      teammate_name: 'reviewer',
    };

    expect(normalizeClaudeTeamLifecycleHook(input)).toEqual({
      type: 'team_task_completed',
      taskId: 'task-1',
      subject: 'Review auth',
      teammateName: 'reviewer',
    });
  });

  it('normalizes TeammateIdle', () => {
    const input: TeammateIdleHookInput = {
      ...base,
      hook_event_name: 'TeammateIdle',
      teammate_name: 'reviewer',
      team_name: 'ignored',
    };

    expect(normalizeClaudeTeamLifecycleHook(input)).toEqual({
      type: 'teammate_idle',
      teammateName: 'reviewer',
    });
  });

  it('rejects blank task identifiers', () => {
    const input: TaskCreatedHookInput = {
      ...base,
      hook_event_name: 'TaskCreated',
      task_id: '  ',
      task_subject: 'Invalid',
    };

    expect(normalizeClaudeTeamLifecycleHook(input)).toBeNull();
  });
});
