import { existsSync } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { debug } from '../../utils/debug.ts';

const UTF8_BOM = '\uFEFF';
const EMPTY_CONFIG = '{}';

export type ClaudeConfigValidationError =
  | { type: 'claude_config_unreadable'; path: string; cause: unknown }
  | { type: 'claude_config_unwritable'; path: string; cause: unknown }
  | { type: 'claude_config_invalid_after_recovery'; path: string; cause: unknown };

export interface ClaudeConfigManager {
  ensureValid(): Promise<void>;
  getValidatedConfig(): Promise<Record<string, unknown>>;
}

interface ClaudeConfigManagerOptions {
  configPath?: string;
}

function createValidationError(
  type: ClaudeConfigValidationError['type'],
  path: string,
  cause: unknown,
): ClaudeConfigValidationError {
  return { type, path, cause };
}

function parseConfig(path: string, content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('Claude config must be a JSON object');
  } catch (cause) {
    throw createValidationError('claude_config_invalid_after_recovery', path, cause);
  }
}

async function writeConfigSafe(configPath: string, content: string): Promise<void> {
  try {
    await writeFile(configPath, content, 'utf-8');
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM')) {
      debug(`[ClaudeConfigManager] Write failed with ${code}, retrying after 100ms...`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await writeFile(configPath, content, 'utf-8');
        debug('[ClaudeConfigManager] Retry succeeded');
        return;
      } catch (retryCause) {
        throw createValidationError('claude_config_unwritable', configPath, retryCause);
      }
    }

    throw createValidationError('claude_config_unwritable', configPath, cause);
  }
}

export function createClaudeConfigManager(
  options: ClaudeConfigManagerOptions = {},
): ClaudeConfigManager {
  const configPath = options.configPath ?? join(homedir(), '.claude.json');
  const configDir = dirname(configPath);
  const configBase = basename(configPath);

  async function cleanupRecoveryArtifacts(): Promise<void> {
    const backupPath = `${configPath}.backup`;
    if (existsSync(backupPath)) {
      try {
        await unlink(backupPath);
        debug('[ClaudeConfigManager] Removed stale ~/.claude.json.backup');
      } catch (cause) {
        debug(`[ClaudeConfigManager] Failed to remove stale backup: ${String(cause)}`);
      }
    }

    try {
      const files = await readdir(configDir);
      await Promise.all(
        files
          .filter((file) => file.startsWith(`${configBase}.corrupted.`))
          .map(async (file) => {
            try {
              await unlink(join(configDir, file));
              debug(`[ClaudeConfigManager] Removed stale ${file}`);
            } catch (cause) {
              debug(`[ClaudeConfigManager] Failed to remove stale ${file}: ${String(cause)}`);
            }
          }),
      );
    } catch (cause) {
      debug(`[ClaudeConfigManager] Failed to scan Claude config directory: ${String(cause)}`);
    }
  }

  async function ensureValid(): Promise<void> {
    await cleanupRecoveryArtifacts();

    if (!existsSync(configPath)) {
      debug('[ClaudeConfigManager] ~/.claude.json missing, creating with {}');
      await writeConfigSafe(configPath, EMPTY_CONFIG);
      return;
    }

    let raw: string;
    try {
      raw = await readFile(configPath, 'utf-8');
    } catch (cause) {
      throw createValidationError('claude_config_unreadable', configPath, cause);
    }

    const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
    const hasBom = raw !== content;

    if (content.trim().length === 0) {
      debug(`[ClaudeConfigManager] ~/.claude.json is empty${hasBom ? ' (had BOM)' : ''}, resetting to {}`);
      await writeConfigSafe(configPath, EMPTY_CONFIG);
      return;
    }

    try {
      parseConfig(configPath, content);
    } catch {
      debug('[ClaudeConfigManager] ~/.claude.json is corrupted, resetting to {}');
      await writeConfigSafe(configPath, EMPTY_CONFIG);
      parseConfig(configPath, EMPTY_CONFIG);
      return;
    }

    if (hasBom) {
      debug('[ClaudeConfigManager] ~/.claude.json had UTF-8 BOM, rewriting without BOM');
      await writeConfigSafe(configPath, content);
    }
  }

  async function getValidatedConfig(): Promise<Record<string, unknown>> {
    await ensureValid();

    let raw: string;
    try {
      raw = await readFile(configPath, 'utf-8');
    } catch (cause) {
      throw createValidationError('claude_config_unreadable', configPath, cause);
    }

    const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
    return parseConfig(configPath, content);
  }

  return {
    ensureValid,
    getValidatedConfig,
  };
}

const defaultClaudeConfigManager = createClaudeConfigManager();

export async function ensureDefaultClaudeConfigValid(): Promise<void> {
  await defaultClaudeConfigManager.ensureValid();
}

