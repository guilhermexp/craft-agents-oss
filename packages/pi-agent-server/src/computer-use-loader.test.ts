import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { COMPUTER_USE_TOOL_NAMES } from './computer-use-tools.ts';
import { SUBAGENT_TOOL_NAMES } from './subagent-tools.ts';

const COMPUTER_USE_V0_5_TOOL_NAMES = [
  'find_roots',
  'observe_ui',
  'search_ui',
  'expand_ui',
  'inspect_ui',
  'act_ui',
  'read_text',
  'wait_for',
  'launch_browser',
  'navigate_browser',
  'evaluate_browser',
] as const;

const LEGACY_COMPUTER_USE_TOOL_NAMES = [
  'screenshot',
  'click',
  'double_click',
  'move_mouse',
  'drag',
  'scroll',
  'keypress',
  'type_text',
  'set_text',
  'wait',
  'computer_actions',
] as const;

interface LoadedExtensions {
  extensionPaths: string[];
  toolNames: string[];
}

async function loadVendoredExtensions(extensionPaths: string[]): Promise<LoadedExtensions> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'craft-pi-resource-loader-'));

  try {
    const loader = new DefaultResourceLoader({
      cwd: temporaryRoot,
      agentDir: join(temporaryRoot, '.pi-agent'),
      additionalExtensionPaths: extensionPaths,
    });
    await loader.reload();

    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);

    return {
      extensionPaths: result.extensions.map(extension => extension.path),
      toolNames: result.extensions.flatMap(extension => [...extension.tools.keys()]),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const subagentsPackageDir = join(import.meta.dir, 'pi-better-subagents');
const computerUsePackageDir = join(import.meta.dir, 'pi-computer-use');

describe('Craft vendored Pi extension loader contract', () => {
  it('loads pi-better-subagents and pi-computer-use through one resource loader without duplicate tools', async () => {
    const loaded = await loadVendoredExtensions([subagentsPackageDir, computerUsePackageDir]);

    expect(loaded.extensionPaths).toHaveLength(2);
    expect(loaded.toolNames).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES, ...COMPUTER_USE_TOOL_NAMES]));
    expect(new Set(loaded.toolNames).size).toBe(loaded.toolNames.length);
  });

  it('does not announce any computer-use tool when its package path is absent', async () => {
    const loaded = await loadVendoredExtensions([subagentsPackageDir]);
    const computerUsePublicNames = new Set<string>([
      ...COMPUTER_USE_V0_5_TOOL_NAMES,
      ...LEGACY_COMPUTER_USE_TOOL_NAMES,
    ]);

    expect(loaded.extensionPaths).toHaveLength(1);
    expect(loaded.toolNames).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
    expect(loaded.toolNames.filter(toolName => computerUsePublicNames.has(toolName))).toEqual([]);
  });
});
