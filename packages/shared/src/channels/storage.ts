import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type { WarRoomChannel, WorkspaceWarRoomChannelsConfig } from './types.ts';
import { warRoomChannelId } from './types.ts';

const CHANNELS_CONFIG_DIR = 'channels';
const CHANNELS_CONFIG_FILE = 'channels/config.json';

export function getDefaultChannelsConfig(): WorkspaceWarRoomChannelsConfig {
  return { version: 1, channels: [] };
}

export function loadChannelsConfig(workspaceRootPath: string): WorkspaceWarRoomChannelsConfig {
  const configPath = join(workspaceRootPath, CHANNELS_CONFIG_FILE);
  if (!existsSync(configPath)) {
    const defaults = getDefaultChannelsConfig();
    saveChannelsConfig(workspaceRootPath, defaults);
    return defaults;
  }

  try {
    const config = readJsonFileSync<WorkspaceWarRoomChannelsConfig>(configPath);
    return {
      version: config.version || 1,
      channels: Array.isArray(config.channels)
        ? config.channels.map(channel => ({ ...channel, id: warRoomChannelId(channel.id) }))
        : [],
    };
  } catch (error) {
    debug('[loadChannelsConfig] Failed to parse config:', error);
    return getDefaultChannelsConfig();
  }
}

export function saveChannelsConfig(
  workspaceRootPath: string,
  config: WorkspaceWarRoomChannelsConfig,
): void {
  const channelsDir = join(workspaceRootPath, CHANNELS_CONFIG_DIR);
  const configPath = join(workspaceRootPath, CHANNELS_CONFIG_FILE);

  if (!existsSync(channelsDir)) {
    mkdirSync(channelsDir, { recursive: true });
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveChannelsConfig] Failed to save config:', error);
    throw error;
  }
}

export function listChannels(workspaceRootPath: string): WarRoomChannel[] {
  return loadChannelsConfig(workspaceRootPath).channels;
}
