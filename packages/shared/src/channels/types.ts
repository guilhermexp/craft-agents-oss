import type { PermissionMode } from '../agent/mode-types.ts';
import type { EntityColor } from '../colors/types.ts';

export interface ChannelConfig {
  id: string;
  name: string;
  description?: string;
  color?: EntityColor;
  labelId: string;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
}

export interface WorkspaceChannelsConfig {
  version: number;
  channels: ChannelConfig[];
}

export interface CreateChannelInput {
  name: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
}

export interface UpdateChannelInput {
  name?: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
}
