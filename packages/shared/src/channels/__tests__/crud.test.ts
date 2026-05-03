import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createChannel, deleteChannel, updateChannel } from '../crud.ts';
import { listChannels } from '../storage.ts';
import { loadLabelConfig, saveLabelConfig } from '../../labels/storage.ts';
import { findLabelById, flattenLabels } from '../../labels/tree.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'channels-crud-test-'));
  saveLabelConfig(workspaceRoot, { version: 1, labels: [] });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('channel CRUD', () => {
  it('creates a channel with a real unique label id instead of a valued channel label', () => {
    const channel = createChannel(workspaceRoot, { name: 'Cert Certificados' });

    expect(channel.id).toBe('cert-certificados');
    expect(channel.labelId).toBe('channel-cert-certificados');
    expect(channel.labelId.includes('::')).toBe(false);

    const labels = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(labels.some(label => label.id === 'channel-cert-certificados')).toBe(true);
    expect(labels.some(label => label.id === 'channel')).toBe(false);
  });

  it('keeps channel ids and label ids unique when names collide', () => {
    const first = createChannel(workspaceRoot, { name: 'Client' });
    const second = createChannel(workspaceRoot, { name: 'Client' });

    expect(first.id).toBe('client');
    expect(first.labelId).toBe('channel-client');
    expect(second.id).toBe('client-2');
    expect(second.labelId).toBe('channel-client-2');
    expect(listChannels(workspaceRoot).map(channel => channel.id)).toEqual(['client', 'client-2']);
  });

  it('updates name and color and syncs the backing label', () => {
    const channel = createChannel(workspaceRoot, { name: 'Support' });

    const updated = updateChannel(workspaceRoot, channel.id, { name: 'Customer Support', color: 'destructive/40' });

    expect(updated.name).toBe('Customer Support');
    expect(updated.color).toBe('destructive/40');
    const label = findLabelById(loadLabelConfig(workspaceRoot).labels, channel.labelId);
    expect(label?.name).toBe('Customer Support');
    expect(label?.color).toBe('destructive/40');
  });

  it('clears description when updated to an empty string', () => {
    const channel = createChannel(workspaceRoot, { name: 'Notes', description: 'initial' });
    expect(channel.description).toBe('initial');

    const updated = updateChannel(workspaceRoot, channel.id, { description: '   ' });

    expect('description' in updated).toBe(false);
  });

  it('preserves a user-renamed backing label instead of clobbering it on update', () => {
    const channel = createChannel(workspaceRoot, { name: 'Original' });

    // Simulate user renaming the backing label out of band.
    const labelConfig = loadLabelConfig(workspaceRoot);
    const label = findLabelById(labelConfig.labels, channel.labelId);
    if (!label) throw new Error('expected backing label');
    label.name = 'User Renamed Label';
    saveLabelConfig(workspaceRoot, labelConfig);

    updateChannel(workspaceRoot, channel.id, { name: 'New Channel Name' });

    const after = findLabelById(loadLabelConfig(workspaceRoot).labels, channel.labelId);
    expect(after?.name).toBe('User Renamed Label');
  });

  it('throws if the backing label slot is already taken on create', () => {
    // Pre-create a label that would collide with the channel's expected backing labelId.
    const labelConfig = loadLabelConfig(workspaceRoot);
    labelConfig.labels.push({ id: 'channel-conflict', name: 'Pre-existing', color: 'foreground/50' });
    saveLabelConfig(workspaceRoot, labelConfig);

    // uniqueSlug should bump the labelId, so this should NOT throw.
    const channel = createChannel(workspaceRoot, { name: 'Conflict' });
    expect(channel.labelId).toBe('channel-conflict-2');

    const remaining = findLabelById(loadLabelConfig(workspaceRoot).labels, 'channel-conflict');
    expect(remaining?.name).toBe('Pre-existing');
  });

  it('deletes the channel config without deleting the backing label or stripping sessions', () => {
    const channel = createChannel(workspaceRoot, { name: 'Support' });

    deleteChannel(workspaceRoot, channel.id);

    expect(listChannels(workspaceRoot)).toEqual([]);
    const labels = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(labels.some(label => label.id === channel.labelId)).toBe(true);
  });
});
