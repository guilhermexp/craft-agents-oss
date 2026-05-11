import { describe, expect, it } from 'bun:test';
import { $ } from 'bun';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeConfigManager,
  type ClaudeConfigValidationError,
} from './claude-config-manager.ts';

function withTempHome(run: (paths: { home: string; configPath: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'craft-claude-config-'));
  const configPath = join(home, '.claude.json');

  return run({ home, configPath }).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
}

describe('ClaudeConfigManager', () => {
  it('cria config ausente com JSON vazio', async () => {
    await withTempHome(async ({ configPath }) => {
      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(readFileSync(configPath, 'utf-8')).toBe('{}');
    });
  });

  it('remove backup stale', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '{"ok":true}', 'utf-8');
      writeFileSync(`${configPath}.backup`, 'stale', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(existsSync(`${configPath}.backup`)).toBe(false);
    });
  });

  it('remove corrupted artifacts stale', async () => {
    await withTempHome(async ({ home, configPath }) => {
      const corruptedPath = join(home, '.claude.json.corrupted.123');
      writeFileSync(configPath, '{"ok":true}', 'utf-8');
      writeFileSync(corruptedPath, 'stale', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(existsSync(corruptedPath)).toBe(false);
    });
  });

  it('recupera arquivo vazio para JSON vazio', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(readFileSync(configPath, 'utf-8')).toBe('{}');
    });
  });

  it('recupera arquivo somente BOM para JSON vazio', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '\uFEFF', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(readFileSync(configPath, 'utf-8')).toBe('{}');
    });
  });

  it('remove BOM de JSON valido preservando dados', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '\uFEFF{"theme":"dark"}', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(readFileSync(configPath, 'utf-8')).toBe('{"theme":"dark"}');
    });
  });

  it('recupera JSON invalido para JSON vazio', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '{invalid', 'utf-8');

      await createClaudeConfigManager({ configPath }).ensureValid();

      expect(readFileSync(configPath, 'utf-8')).toBe('{}');
    });
  });

  it('retorna erro tipado quando nao consegue escrever', async () => {
    const home = mkdtempSync(join(tmpdir(), 'craft-claude-config-'));
    const configPath = join(home, 'missing-dir', '.claude.json');

    try {
      await createClaudeConfigManager({ configPath }).ensureValid();
      throw new Error('Expected ensureValid to fail');
    } catch (error) {
      const typedError = error as ClaudeConfigValidationError;
      expect(typedError.type).toBe('claude_config_unwritable');
      expect(typedError.path).toBe(configPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('getValidatedConfig retorna objeto parseado para config saudavel', async () => {
    await withTempHome(async ({ configPath }) => {
      writeFileSync(configPath, '{"theme":"dark","count":2}', 'utf-8');

      await expect(createClaudeConfigManager({ configPath }).getValidatedConfig()).resolves.toEqual({
        theme: 'dark',
        count: 2,
      });
    });
  });

  it('getDefaultOptions nao toca em .claude.json', async () => {
    await withTempHome(async ({ home, configPath }) => {
      await $`bun -e "import { getDefaultOptions } from './src/agent/options.ts'; getDefaultOptions();"`
        .cwd(join(import.meta.dir, '..', '..', '..'))
        .env({ ...process.env, HOME: home });

      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(`${configPath}.backup`)).toBe(false);
    });
  });
});

