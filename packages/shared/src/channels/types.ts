import type { PermissionMode } from '../agent/mode-types.ts';
import type { CraftBridgeChannelContext } from '../craft-bridge/context.ts';
import type { EntityColor } from '../colors/types.ts';
import type { Opaque } from '../opaque.ts';

export type WarRoomChannelId = Opaque<string, 'WarRoomChannelId'>;

export function warRoomChannelId(value: string): WarRoomChannelId {
  return value as WarRoomChannelId;
}

export interface WarRoomChannel {
  id: WarRoomChannelId;
  name: string;
  description?: string;
  color?: EntityColor;
  labelId: string;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
  workingDirectory?: string;
  participants?: WarRoomParticipant[];
  routing?: WarRoomRoutingConfig;
  craftBridgeContext?: CraftBridgeChannelContext;
}

export interface WorkspaceWarRoomChannelsConfig {
  version: number;
  channels: WarRoomChannel[];
}

export interface WarRoomParticipant {
  id: string;
  displayName: string;
  llmConnection: string;
  model?: string;
  hermesProfile?: string;
  defaultSourceSlugs?: string[];
  permissionMode?: PermissionMode;
  workingDirectory?: string;
}

export interface WarRoomRoutingConfig {
  mode: 'manual-tags' | 'lead' | 'all' | 'orchestrator';
  leadParticipantId?: string;
  allowAllMention?: boolean;
}

export type WarRoomDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WarRoomDispatch {
  id: string;
  channelId: string;
  participantId: string;
  sourceMessageId: string;
  parentMessageId?: string;
  sourceSessionId?: string;
  status: WarRoomDispatchStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWarRoomChannelInput {
  name: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
  workingDirectory?: string;
  participants?: WarRoomParticipant[];
  routing?: WarRoomRoutingConfig;
  craftBridgeContext?: CraftBridgeChannelContext;
}

export interface UpdateWarRoomChannelInput {
  name?: string;
  description?: string;
  color?: EntityColor;
  defaultSourceSlugs?: string[];
  defaultPermissionMode?: PermissionMode;
  workingDirectory?: string;
  participants?: WarRoomParticipant[];
  routing?: WarRoomRoutingConfig;
  craftBridgeContext?: CraftBridgeChannelContext;
}
