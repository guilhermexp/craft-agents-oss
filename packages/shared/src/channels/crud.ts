import { loadChannelsConfig, saveChannelsConfig } from './storage.ts';
import type { CreateWarRoomChannelInput, UpdateWarRoomChannelInput, WarRoomChannel, WorkspaceWarRoomChannelsConfig } from './types.ts';
import { warRoomChannelId } from './types.ts';
import { loadLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import { collectAllIds, findLabelById } from '../labels/tree.ts';
import type { LabelConfig } from '../labels/types.ts';
import { deleteLabel } from '../labels/crud.ts';

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PARTICIPANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

function uniqueSlug(base: string, used: Set<string>): string {
  const root = base || 'channel';
  let candidate = root;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${root}-${suffix}`;
    suffix++;
  }
  return candidate;
}

function assertValidChannelName(name: string): void {
  if (!name.trim()) {
    throw new Error('Channel name is required');
  }
  if (slugify(name) === '') {
    throw new Error('Channel name must contain alphanumeric characters');
  }
}

function assertUniqueChannelName(
  name: string,
  config: WorkspaceWarRoomChannelsConfig,
  excludeId?: string,
): void {
  const target = name.trim().toLowerCase();
  const collision = config.channels.find(
    channel => channel.id !== excludeId && channel.name.trim().toLowerCase() === target,
  );
  if (collision) {
    throw new Error(`A channel named ${collision.name.trim()} already exists`);
  }
}

function normalizeParticipants(
  participants: WarRoomChannel['participants'] | undefined,
): WarRoomChannel['participants'] | undefined {
  if (participants === undefined) return undefined;

  const seen = new Set<string>();
  const normalized = participants.map(participant => {
    const id = participant.id.trim().toLowerCase();
    if (!PARTICIPANT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid channel participant id: ${participant.id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate participant id: ${id}`);
    }
    seen.add(id);

    const displayName = participant.displayName.trim();
    if (!displayName) {
      throw new Error(`Channel participant '${id}' display name is required`);
    }
    const llmConnection = participant.llmConnection.trim();
    if (!llmConnection) {
      throw new Error(`Channel participant '${id}' llmConnection is required`);
    }

    return {
      id,
      displayName,
      llmConnection,
      ...(participant.model !== undefined ? { model: participant.model } : {}),
      ...(participant.hermesProfile !== undefined ? { hermesProfile: participant.hermesProfile } : {}),
      ...(participant.defaultSourceSlugs !== undefined ? { defaultSourceSlugs: participant.defaultSourceSlugs } : {}),
      ...(participant.permissionMode !== undefined ? { permissionMode: participant.permissionMode } : {}),
      ...(participant.workingDirectory !== undefined ? { workingDirectory: participant.workingDirectory } : {}),
    };
  });

  return normalized.length > 0 ? normalized : undefined;
}

interface EnsureChannelLabelOptions {
  // Previous channel name. If set, sync label only when its current name still
  // matches — preserves user edits to the backing label.
  previousName?: string;
  // True on createChannel — fail if backing label already exists, since
  // uniqueSlug should have produced a fresh id.
  expectFresh?: boolean;
}

function ensureChannelLabel(
  workspaceRootPath: string,
  channel: Pick<WarRoomChannel, 'name' | 'labelId' | 'color'>,
  options: EnsureChannelLabelOptions = {},
): void {
  if (!SLUG_PATTERN.test(channel.labelId) || channel.labelId.includes('::')) {
    throw new Error(`Invalid channel label id: ${channel.labelId}`);
  }

  const labelConfig = loadLabelConfig(workspaceRootPath);
  const existing = findLabelById(labelConfig.labels, channel.labelId);
  if (existing) {
    if (options.expectFresh) {
      throw new Error(`Backing label '${channel.labelId}' already exists`);
    }
    // Sync only if user hasn't renamed the backing label out from under us.
    const userRenamed = options.previousName !== undefined && existing.name !== options.previousName;
    if (!userRenamed) {
      existing.name = channel.name;
      if (channel.color !== undefined) existing.color = channel.color;
      saveLabelConfig(workspaceRootPath, labelConfig);
    }
    return;
  }

  const label: LabelConfig = {
    id: channel.labelId,
    name: channel.name,
    color: channel.color ?? 'foreground/50',
  };

  labelConfig.labels.push(label);
  saveLabelConfig(workspaceRootPath, labelConfig);
}

export function createChannel(workspaceRootPath: string, input: CreateWarRoomChannelInput): WarRoomChannel {
  assertValidChannelName(input.name);

  const config = loadChannelsConfig(workspaceRootPath);
  assertUniqueChannelName(input.name, config);
  const channelIds = new Set<string>(config.channels.map(channel => channel.id));
  const labelIds = collectAllIds(loadLabelConfig(workspaceRootPath).labels);
  const id = warRoomChannelId(uniqueSlug(slugify(input.name), channelIds));
  const labelId = uniqueSlug(`channel-${id}`, labelIds);
  const participants = normalizeParticipants(input.participants);

  const channel: WarRoomChannel = {
    id,
    name: input.name.trim(),
    labelId,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.defaultSourceSlugs !== undefined ? { defaultSourceSlugs: input.defaultSourceSlugs } : {}),
    ...(input.defaultPermissionMode !== undefined ? { defaultPermissionMode: input.defaultPermissionMode } : {}),
    ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
    ...(participants !== undefined ? { participants } : {}),
    ...(input.routing !== undefined ? { routing: input.routing } : {}),
  };

  ensureChannelLabel(workspaceRootPath, channel, { expectFresh: true });
  config.channels.push(channel);
  saveChannelsConfig(workspaceRootPath, config);
  return channel;
}

export function updateChannel(
  workspaceRootPath: string,
  channelId: string,
  updates: UpdateWarRoomChannelInput,
): WarRoomChannel {
  const config = loadChannelsConfig(workspaceRootPath);
  const channel = config.channels.find(item => item.id === channelId);
  if (!channel) throw new Error(`Channel '${channelId}' not found`);
  const previousName = channel.name;

  if (updates.name !== undefined) {
    assertValidChannelName(updates.name);
    assertUniqueChannelName(updates.name, config, channelId);
    channel.name = updates.name.trim();
  }
  if (updates.description !== undefined) {
    const trimmed = updates.description.trim();
    if (trimmed) {
      channel.description = trimmed;
    } else {
      delete channel.description;
    }
  }
  if (updates.color !== undefined) channel.color = updates.color;
  if (updates.defaultSourceSlugs !== undefined) channel.defaultSourceSlugs = updates.defaultSourceSlugs;
  if (updates.defaultPermissionMode !== undefined) channel.defaultPermissionMode = updates.defaultPermissionMode;
  if (updates.workingDirectory !== undefined) channel.workingDirectory = updates.workingDirectory;
  if (updates.participants !== undefined) {
    const participants = normalizeParticipants(updates.participants);
    if (participants) {
      channel.participants = participants;
    } else {
      delete channel.participants;
    }
  }
  if (updates.routing !== undefined) channel.routing = updates.routing;

  ensureChannelLabel(workspaceRootPath, channel, { previousName });
  saveChannelsConfig(workspaceRootPath, config);
  return channel;
}

export interface DeleteChannelOptions {
  removeBackingLabel?: boolean;
}

export interface DeleteChannelResult {
  deleted: boolean;
  labelDeleted?: boolean;
}

export function deleteChannel(
  workspaceRootPath: string,
  channelId: string,
  options: DeleteChannelOptions = {},
): DeleteChannelResult {
  const config = loadChannelsConfig(workspaceRootPath);
  const target = config.channels.find(channel => channel.id === channelId);
  if (!target) {
    throw new Error(`Channel '${channelId}' not found`);
  }
  config.channels = config.channels.filter(channel => channel.id !== channelId);
  saveChannelsConfig(workspaceRootPath, config);

  let labelDeleted: boolean | undefined;
  if (options.removeBackingLabel) {
    const labelConfig = loadLabelConfig(workspaceRootPath);
    if (findLabelById(labelConfig.labels, target.labelId)) {
      try {
        deleteLabel(workspaceRootPath, target.labelId);
        labelDeleted = true;
      } catch {
        labelDeleted = false;
      }
    } else {
      labelDeleted = false;
    }
  }

  return labelDeleted === undefined ? { deleted: true } : { deleted: true, labelDeleted };
}
