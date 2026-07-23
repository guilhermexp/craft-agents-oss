import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createWorkspaceAtPath, getWorkspaceMeetingsPath, loadWorkspace, loadWorkspaceConfig } from '../storage.ts';

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
      join(homedir(), '.craft-agent', 'workspaces', loadWorkspaceConfig(workspaceRoot)!.id, 'meetings'),
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

  it('keys meetings storage by workspace config id, not rootPath basename', () => {
    const parentA = mkdtempSync(join(tmpdir(), 'craft-ws-a-'));
    const parentB = mkdtempSync(join(tmpdir(), 'craft-ws-b-'));
    tempDirs.push(parentA, parentB);
    const rootA = join(parentA, 'work');
    const rootB = join(parentB, 'work'); // mesmo basename, workspaces distintos
    createWorkspaceAtPath(rootA, 'Work A');
    createWorkspaceAtPath(rootB, 'Work B');
    metadataDirs.push(dirname(getWorkspaceMeetingsPath(rootA)), dirname(getWorkspaceMeetingsPath(rootB)));

    expect(getWorkspaceMeetingsPath(rootA)).not.toBe(getWorkspaceMeetingsPath(rootB));
  });

  it('migrates a legacy basename-keyed meetings dir and rewrites recording paths', () => {
    const parent = mkdtempSync(join(tmpdir(), 'craft-ws-mig-'));
    tempDirs.push(parent);
    const root = join(parent, 'legacy-ws');
    createWorkspaceAtPath(root, 'Legacy WS');
    const config = loadWorkspaceConfig(root)!;

    // Simula o layout antigo: dir keyed por basename com um recording referenciado.
    const legacyDir = join(homedir(), '.craft-agent', 'workspaces', 'legacy-ws', 'meetings');
    const newDir = join(homedir(), '.craft-agent', 'workspaces', config.id, 'meetings');
    metadataDirs.push(dirname(legacyDir), dirname(newDir));
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(join(legacyDir, 'recordings'), { recursive: true });
    const legacyWebm = join(legacyDir, 'recordings', 'm1.webm');
    writeFileSync(legacyWebm, 'x', 'utf8');
    writeFileSync(join(legacyDir, 'meetings.json'), JSON.stringify({
      version: 1,
      meetings: [{ id: 'm1', provider: 'google-meet', status: 'stopped', url: 'https://meet.google.com/abc-defg-hij', browserInstanceId: 'b1', startedAt: 1, updatedAt: 1, recording: { path: legacyWebm, bytesWritten: 1, durationMs: 1 } }],
    }), 'utf8');

    const resolved = getWorkspaceMeetingsPath(root);

    expect(resolved).toBe(newDir);
    expect(existsSync(join(newDir, 'meetings.json'))).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
    const store = JSON.parse(readFileSync(join(newDir, 'meetings.json'), 'utf8')) as { meetings: Array<{ recording?: { path: string } }> };
    expect(store.meetings[0]!.recording!.path).toBe(join(newDir, 'recordings', 'm1.webm'));
  });
});
