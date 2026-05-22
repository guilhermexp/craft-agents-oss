import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createWorkspaceAtPath, getWorkspaceMeetingsPath, loadWorkspace } from '../storage.ts';

const tempDirs: string[] = [];
const metadataDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of metadataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace storage: meetings directory', () => {
  it('creates meetings storage for new workspaces', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-meetings-new-'));
    tempDirs.push(workspaceRoot);

    createWorkspaceAtPath(workspaceRoot, 'Meetings Workspace');
    metadataDirs.push(dirname(getWorkspaceMeetingsPath(workspaceRoot)));

    expect(getWorkspaceMeetingsPath(workspaceRoot)).toBe(
      join(homedir(), '.craft-agent', 'workspaces', workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) || 'workspace', 'meetings'),
    );
    expect(existsSync(getWorkspaceMeetingsPath(workspaceRoot))).toBe(true);
  });

  it('migrates existing workspaces by ensuring meetings storage on load', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-meetings-existing-'));
    tempDirs.push(workspaceRoot);

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
      id: 'ws_123',
      name: 'Existing Workspace',
      slug: 'existing-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2), 'utf8');

    expect(loadWorkspace(workspaceRoot)).not.toBeNull();
    metadataDirs.push(dirname(getWorkspaceMeetingsPath(workspaceRoot)));
    expect(existsSync(getWorkspaceMeetingsPath(workspaceRoot))).toBe(true);
  });
});
