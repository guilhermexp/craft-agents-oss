import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@craft-agent/shared/agent';
import type { Workspace } from '@craft-agent/shared/config';
import { SessionManager, createManagedSession } from './SessionManager.ts';

describe('Claude implicit-team lifecycle', () => {
  let tmpRoot: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-claude-team-'));
    manager = new SessionManager();
    const workspace = {
      id: 'workspace-1',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as Workspace;
    manager.registerManagedSession(createManagedSession(
      { id: 'session-1', name: 'Claude team test' },
      workspace,
      { messagesLoaded: true },
    ));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function fire(event: AgentEvent): Promise<void> {
    await manager.dispatchAgentEvent(manager.getManagedSession('session-1')!, event);
  }

  it('marks a named background agent idle', async () => {
    await fire({
      type: 'task_backgrounded',
      toolUseId: 'tool-agent',
      taskId: 'agent-1',
      intent: 'Review auth',
      agentName: 'reviewer',
    });
    await fire({ type: 'teammate_idle', teammateName: 'reviewer' });

    expect(manager.listBackgroundTasks('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'agent-1',
        agentName: 'reviewer',
        isIdle: true,
      }),
    ]));
  });

  it('tracks a shared team task from creation through completion', async () => {
    await fire({
      type: 'team_task_created',
      taskId: 'task-1',
      subject: 'Review auth',
      description: 'Check token refresh',
      teammateName: 'reviewer',
    });

    expect(manager.listBackgroundTasks('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-1',
        kind: 'team-task',
        status: 'running',
        intent: 'Check token refresh',
        agentName: 'reviewer',
      }),
    ]));

    await fire({
      type: 'team_task_completed',
      taskId: 'task-1',
      subject: 'Review auth',
      teammateName: 'reviewer',
    });

    expect(manager.listBackgroundTasks('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-1',
        kind: 'team-task',
        status: 'completed',
        agentName: 'reviewer',
      }),
    ]));
  });

  it('records completion even when the create hook was missed', async () => {
    await fire({
      type: 'team_task_completed',
      taskId: 'task-missed',
      subject: 'Recovered task',
    });

    await fire({
      type: 'team_task_created',
      taskId: 'task-missed',
      subject: 'Recovered task',
      description: 'Recovered details',
      teammateName: 'reviewer',
    });

    expect(manager.listBackgroundTasks('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-missed',
        kind: 'team-task',
        status: 'completed',
        intent: 'Recovered details',
        agentName: 'reviewer',
      }),
    ]));
  });
});
