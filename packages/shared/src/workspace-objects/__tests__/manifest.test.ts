import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceObjectManifestPath, readWorkspaceObjectManifest, writeWorkspaceObjectManifest } from '../manifest.ts';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

describe('workspace object manifest boundary', () => {
  test('rejects nested fields and unknown keys that do not match the complete manifest schema', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-manifest-'));
    const path = join(root, 'object.yaml');
    writeFileSync(path, [
      'schemaVersion: 1',
      'id: object_people',
      'slug: people',
      'name: People',
      'revision: 1',
      'fields:',
      '  - id: field_name',
      '    name: Name',
      '    type: unsupported',
      '    required: false',
      'unexpected: true',
    ].join('\n'));

    expect(() => readWorkspaceObjectManifest(path)).toThrow('Invalid workspace object manifest');
  });

  test('validates slug before joining it into the workspace path', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-manifest-path-'));
    expect(() => getWorkspaceObjectManifestPath(root, '../escape')).toThrow('Invalid workspace object slug');
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  test('repairs corrupt YAML while preserving identity conflicts from valid manifests', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-manifest-repair-'));
    const payload = {
      id: 'object_people', slug: 'people', name: 'People', revision: 1,
      projectionStatus: 'ready' as const, fields: [], entries: [], savedViews: [],
    };
    const path = getWorkspaceObjectManifestPath(root, payload.slug);
    mkdirSync(join(root, 'objects', payload.slug), { recursive: true });
    writeFileSync(path, 'not: [valid');

    expect(writeWorkspaceObjectManifest(root, payload)).toBe(path);
    expect(readWorkspaceObjectManifest(path)).toMatchObject({ id: payload.id, slug: payload.slug, revision: 1 });

    writeFileSync(path, readFileSync(path, 'utf8').replace('id: object_people', 'id: object_other'));
    expect(() => writeWorkspaceObjectManifest(root, payload)).toThrow('identity conflict');
  });
});
