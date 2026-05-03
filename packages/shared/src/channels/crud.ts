import { loadChannelsConfig, saveChannelsConfig } from './storage.ts';
import type { ChannelConfig, CreateChannelInput, UpdateChannelInput } from './types.ts';
import { loadLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import { collectAllIds, findLabelById } from '../labels/tree.ts';
import type { LabelConfig } from '../labels/types.ts';

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

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
  channel: Pick<ChannelConfig, 'name' | 'labelId' | 'color'>,
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

export function createChannel(workspaceRootPath: string, input: CreateChannelInput): ChannelConfig {
  assertValidChannelName(input.name);

  const config = loadChannelsConfig(workspaceRootPath);
  const channelIds = new Set(config.channels.map(channel => channel.id));
  const labelIds = collectAllIds(loadLabelConfig(workspaceRootPath).labels);
  const id = uniqueSlug(slugify(input.name), channelIds);
  const labelId = uniqueSlug(`channel-${id}`, labelIds);

  const channel: ChannelConfig = {
    id,
    name: input.name.trim(),
    labelId,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.defaultSourceSlugs !== undefined ? { defaultSourceSlugs: input.defaultSourceSlugs } : {}),
    ...(input.defaultPermissionMode !== undefined ? { defaultPermissionMode: input.defaultPermissionMode } : {}),
  };

  ensureChannelLabel(workspaceRootPath, channel, { expectFresh: true });
  config.channels.push(channel);
  saveChannelsConfig(workspaceRootPath, config);
  return channel;
}

export function updateChannel(
  workspaceRootPath: string,
  channelId: string,
  updates: UpdateChannelInput,
): ChannelConfig {
  const config = loadChannelsConfig(workspaceRootPath);
  const channel = config.channels.find(item => item.id === channelId);
  if (!channel) throw new Error(`Channel '${channelId}' not found`);
  const previousName = channel.name;

  if (updates.name !== undefined) {
    assertValidChannelName(updates.name);
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

  ensureChannelLabel(workspaceRootPath, channel, { previousName });
  saveChannelsConfig(workspaceRootPath, config);
  return channel;
}

export function deleteChannel(workspaceRootPath: string, channelId: string): { deleted: boolean } {
  const config = loadChannelsConfig(workspaceRootPath);
  const before = config.channels.length;
  config.channels = config.channels.filter(channel => channel.id !== channelId);
  if (config.channels.length === before) {
    throw new Error(`Channel '${channelId}' not found`);
  }
  saveChannelsConfig(workspaceRootPath, config);
  return { deleted: true };
}
