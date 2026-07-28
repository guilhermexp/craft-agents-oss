import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createWorkspaceAtPath, getWorkspaceMeetingsPath, loadWorkspace, loadWorkspaceConfig } from '../storage.ts';

/**
 * Workspace metadata paths resolve the config root at call time, so pointing
 * `CRAFT_CONFIG_DIR` at a tmpdir keeps this suite out of the user's real
 * `~/.craft-agent`. Teardown removes exactly one directory.
 *
 * `config-defaults.json` is still read from the root `config/paths.ts` captured
 * at import time (read-only), so this override only redirects writes; a machine
 * without that file needs the app's normal startup sync first.
 */
const configRoot = mkdtempSync(join(tmpdir(), 'craft-config-ws-meetings-'));
process.env.CRAFT_CONFIG_DIR = configRoot;

const realWorkspacesDir = join(homedir(), '.craft-agent', 'workspaces');

function listRealWorkspaces(): string[] {
  try {
    return readdirSync(realWorkspacesDir).sort();
  } catch {
    return [];
  }
}

let realWorkspacesBefore: string[] = [];

beforeAll(() => {
  realWorkspacesBefore = listRealWorkspaces();
});

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace storage: meetings directory', () => {
  it('creates meetings storage for new workspaces', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-meetings-new-'));
    tempDirs.push(workspaceRoot);

    createWorkspaceAtPath(workspaceRoot, 'Meetings Workspace');

    expect(getWorkspaceMeetingsPath(workspaceRoot)).toBe(
      join(configRoot, 'workspaces', loadWorkspaceConfig(workspaceRoot)!.id, 'meetings'),
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

    expect(getWorkspaceMeetingsPath(rootA)).not.toBe(getWorkspaceMeetingsPath(rootB));
  });

  it('migrates a legacy basename-keyed meetings dir and rewrites recording paths', () => {
    const parent = mkdtempSync(join(tmpdir(), 'craft-ws-mig-'));
    tempDirs.push(parent);
    const root = join(parent, 'legacy-ws');
    createWorkspaceAtPath(root, 'Legacy WS');
    const config = loadWorkspaceConfig(root)!;

    // Simula o layout antigo: dir keyed por basename com um recording referenciado.
    const legacyDir = join(configRoot, 'workspaces', 'legacy-ws', 'meetings');
    const newDir = join(configRoot, 'workspaces', config.id, 'meetings');
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

describe('workspace storage: config root override', () => {
  it('resolves meetings storage under the runtime config root override', () => {
    const parent = mkdtempSync(join(tmpdir(), 'craft-ws-override-'));
    tempDirs.push(parent);
    const overrideRoot = join(parent, 'config-root');
    const workspaceRoot = join(parent, 'ws');
    mkdirSync(workspaceRoot, { recursive: true });

    const previous = process.env.CRAFT_CONFIG_DIR;
    process.env.CRAFT_CONFIG_DIR = overrideRoot;
    try {
      // Override is read per call, not captured at module load.
      expect(getWorkspaceMeetingsPath(workspaceRoot)).toBe(
        join(overrideRoot, 'workspaces', 'ws', 'meetings'),
      );
    } finally {
      process.env.CRAFT_CONFIG_DIR = previous;
    }

    expect(getWorkspaceMeetingsPath(workspaceRoot)).toBe(
      join(configRoot, 'workspaces', 'ws', 'meetings'),
    );
  });

  it('keeps resolving under the user config root when no override is set', () => {
    const parent = mkdtempSync(join(tmpdir(), 'craft-ws-default-'));
    tempDirs.push(parent);
    const workspaceRoot = join(parent, 'plain-ws');
    mkdirSync(workspaceRoot, { recursive: true });

    const previous = process.env.CRAFT_CONFIG_DIR;
    delete process.env.CRAFT_CONFIG_DIR;
    try {
      expect(getWorkspaceMeetingsPath(workspaceRoot)).toBe(
        join(homedir(), '.craft-agent', 'workspaces', basename(workspaceRoot), 'meetings'),
      );
    } finally {
      process.env.CRAFT_CONFIG_DIR = previous;
    }
  });

  it('leaves the real user config root untouched', () => {
    expect(listRealWorkspaces()).toEqual(realWorkspacesBefore);
  });
});
