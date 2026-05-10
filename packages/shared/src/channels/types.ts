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
  workingDirectory?: string;
  participants?: ChannelParticipant[];
  routing?: ChannelRoutingConfig;
}

export interface WorkspaceChannelsConfig {
  version: number;
  channels: ChannelConfig[];
}

export interface ChannelParticipant {
  id: string;
  displayName: string;
  llmConnection: string;
  model?: string;
  hermesProfile?: string;
  defaultSourceSlugs?: string[];
  permissionMode?: PermissionMode;
  workingDirectory?: string;
}

export interface ChannelRoutingConfig {
  mode: 'manual-tags' | 'lead' | 'all' | 'orchestrator';
  leadParticipantId?: string;
  allowAllMention?: boolean;
}

export interface CreateChannelInput {
  name: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
  workingDirectory?: string;
  participants?: ChannelParticipant[];
  routing?: ChannelRoutingConfig;
}

export interface UpdateChannelInput {
  name?: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
  workingDirectory?: string;
  participants?: ChannelParticipant[];
  routing?: ChannelRoutingConfig;
}
