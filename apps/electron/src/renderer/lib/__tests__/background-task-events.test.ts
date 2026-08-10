import { describe, expect, it } from 'bun:test';
import type { BackgroundTask } from '../../atoms/sessions';
import { reduceBackgroundTasks } from '../background-task-events';

const runningAgent: BackgroundTask = {
  id: 'agent-1',
  type: 'agent',
  toolUseId: 'tool-agent',
  startTime: 100,
  elapsedSeconds: 0,
  status: 'running',
  agentName: 'reviewer',
};

describe('reduceBackgroundTasks', () => {
  it('projects workflow launches and completion progress', () => {
    const launched = reduceBackgroundTasks([], {
      type: 'task_backgrounded',
      sessionId: 'session-1',
      taskId: 'workflow-task',
      toolUseId: 'tool-workflow',
      kind: 'workflow',
      workflowId: 'wf-1',
      intent: 'Review modules',
    }, 100);

    expect(launched).toEqual([
      expect.objectContaining({
        id: 'workflow-task',
        type: 'workflow',
        workflowId: 'wf-1',
        agentsCompleted: 0,
      }),
    ]);

    const completed = reduceBackgroundTasks(launched, {
      type: 'workflow_agent_completed',
      sessionId: 'session-1',
      workflowId: 'wf-1',
      agentId: 'agent-1',
    }, 200);
    const duplicate = reduceBackgroundTasks(completed, {
      type: 'workflow_agent_completed',
      sessionId: 'session-1',
      workflowId: 'wf-1',
      agentId: 'agent-1',
    }, 300);

    expect(completed[0]?.agentsCompleted).toBe(1);
    expect(duplicate).toBe(completed);
  });

  it('projects shared team tasks through completion', () => {
    const created = reduceBackgroundTasks([], {
      type: 'team_task_created',
      sessionId: 'session-1',
      taskId: 'task-1',
      subject: 'Review auth',
      description: 'Check token refresh',
      teammateName: 'reviewer',
    }, 100);

    expect(created).toEqual([
      expect.objectContaining({
        id: 'task-1',
        type: 'team-task',
        intent: 'Check token refresh',
        agentName: 'reviewer',
        status: 'running',
      }),
    ]);

    expect(reduceBackgroundTasks(created, {
      type: 'team_task_completed',
      sessionId: 'session-1',
      taskId: 'task-1',
      subject: 'Review auth',
      teammateName: 'reviewer',
    }, 200)[0]).toMatchObject({
      status: 'completed',
      completedAt: 200,
    });
  });

  it('marks teammates idle and active again when messaged', () => {
    const idle = reduceBackgroundTasks([runningAgent], {
      type: 'teammate_idle',
      sessionId: 'session-1',
      teammateName: 'reviewer',
    }, 200);
    expect(idle[0]?.isIdle).toBe(true);

    const active = reduceBackgroundTasks(idle, {
      type: 'tool_start',
      sessionId: 'session-1',
      toolUseId: 'tool-message',
      toolName: 'SendMessage',
      toolInput: { to: 'reviewer', message: 'Continue' },
    }, 300);
    expect(active[0]?.isIdle).toBe(false);
  });

  it('retains terminal task data instead of removing the chip immediately', () => {
    expect(reduceBackgroundTasks([{ ...runningAgent, isIdle: true }], {
      type: 'task_completed',
      sessionId: 'session-1',
      taskId: 'agent-1',
      status: 'failed',
      outputFile: '/tmp/agent-1.output',
      summary: 'Review failed',
    }, 500)[0]).toMatchObject({
      status: 'failed',
      completedAt: 500,
      outputFile: '/tmp/agent-1.output',
      summary: 'Review failed',
      isIdle: false,
    });
  });

  it('matches workflow completion by workflow id', () => {
    const launched = reduceBackgroundTasks([], {
      type: 'task_backgrounded',
      sessionId: 'session-1',
      taskId: 'workflow-task',
      toolUseId: 'tool-workflow',
      kind: 'workflow',
      workflowId: 'wf-1',
    }, 100);

    expect(reduceBackgroundTasks(launched, {
      type: 'task_completed',
      sessionId: 'session-1',
      taskId: 'wf-1',
      status: 'completed',
      outputFile: '/tmp/wf-1.output',
    }, 200)[0]).toMatchObject({
      id: 'workflow-task',
      status: 'completed',
      completedAt: 200,
      outputFile: '/tmp/wf-1.output',
    });
  });

  it('does not resurrect completion that arrives before backgrounding', () => {
    const completed = reduceBackgroundTasks([], {
      type: 'task_completed',
      sessionId: 'session-1',
      taskId: 'agent-missed',
      status: 'completed',
    }, 100);

    const enriched = reduceBackgroundTasks(completed, {
      type: 'task_backgrounded',
      sessionId: 'session-1',
      taskId: 'agent-missed',
      toolUseId: 'tool-agent',
      intent: 'Review auth',
      agentName: 'reviewer',
    }, 200);

    expect(enriched[0]).toMatchObject({
      id: 'agent-missed',
      toolUseId: 'tool-agent',
      intent: 'Review auth',
      agentName: 'reviewer',
      status: 'completed',
      completedAt: 100,
      startTime: 100,
    });
  });

  it('does not resurrect a team task completed before creation', () => {
    const completed = reduceBackgroundTasks([], {
      type: 'team_task_completed',
      sessionId: 'session-1',
      taskId: 'task-missed',
      subject: 'Review auth',
    }, 100);

    const enriched = reduceBackgroundTasks(completed, {
      type: 'team_task_created',
      sessionId: 'session-1',
      taskId: 'task-missed',
      subject: 'Review auth',
      description: 'Check token refresh',
      teammateName: 'reviewer',
    }, 200);

    expect(enriched[0]).toMatchObject({
      intent: 'Check token refresh',
      agentName: 'reviewer',
      status: 'completed',
      completedAt: 100,
      startTime: 100,
    });
  });

  it('returns the same array for unrelated events', () => {
    const tasks = [runningAgent];
    expect(reduceBackgroundTasks(tasks, {
      type: 'status',
      sessionId: 'session-1',
      message: 'working',
    }, 200)).toBe(tasks);
  });
});
