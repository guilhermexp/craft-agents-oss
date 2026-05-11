import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ensureHermesSeedSkills } from '../seed.ts';
import { setBundledAssetsRoot } from '../../utils/paths.ts';

describe('Hermes seed skills', () => {
  let tempDir = '';
  let envSnapshot: string | undefined;

  beforeEach(() => {
    envSnapshot = process.env.CRAFT_HERMES_HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'craft-hermes-seed-'));
    setBundledAssetsRoot(tempDir);
  });

  afterEach(() => {
    if (envSnapshot === undefined) {
      delete process.env.CRAFT_HERMES_HOME;
    } else {
      process.env.CRAFT_HERMES_HOME = envSnapshot;
    }
    rmSync(tempDir, { recursive: true, force: true });
    setBundledAssetsRoot('');
  });

  it('copies missing bundled seed skills into the app-scoped Hermes home', () => {
    const seedSkillDir = join(tempDir, 'resources', 'hermes-seed', 'skills', 'craft-embedded-runtime');
    mkdirSync(seedSkillDir, { recursive: true });
    writeFileSync(join(seedSkillDir, 'SKILL.md'), '# Craft Embedded Hermes Runtime\n');
    writeFileSync(join(tempDir, 'resources', 'hermes-seed', 'manifest.json'), JSON.stringify({
      version: 1,
      skills: [
        {
          name: 'craft-embedded-runtime',
          source: 'skills/craft-embedded-runtime',
          target: 'skills/craft/craft-embedded-runtime',
          mergePolicy: 'copy-if-missing',
        },
      ],
    }));

    const hermesHome = join(tempDir, 'hermes-home');
    process.env.CRAFT_HERMES_HOME = hermesHome;

    const result = ensureHermesSeedSkills();

    expect(result.errors).toEqual([]);
    expect(result.copied).toEqual(['craft-embedded-runtime']);
    expect(readFileSync(join(hermesHome, 'skills', 'craft', 'craft-embedded-runtime', 'SKILL.md'), 'utf-8')).toContain('Craft Embedded Hermes Runtime');
  });

  it('preserves existing user-edited seed skills', () => {
    const seedSkillDir = join(tempDir, 'resources', 'hermes-seed', 'skills', 'craft-embedded-runtime');
    mkdirSync(seedSkillDir, { recursive: true });
    writeFileSync(join(seedSkillDir, 'SKILL.md'), '# Bundled\n');
    writeFileSync(join(tempDir, 'resources', 'hermes-seed', 'manifest.json'), JSON.stringify({
      skills: [
        {
          name: 'craft-embedded-runtime',
          source: 'skills/craft-embedded-runtime',
          target: 'skills/craft/craft-embedded-runtime',
        },
      ],
    }));

    const hermesHome = join(tempDir, 'hermes-home');
    const targetSkillDir = join(hermesHome, 'skills', 'craft', 'craft-embedded-runtime');
    mkdirSync(targetSkillDir, { recursive: true });
    writeFileSync(join(targetSkillDir, 'SKILL.md'), '# User edit\n');
    process.env.CRAFT_HERMES_HOME = hermesHome;

    const result = ensureHermesSeedSkills();

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(['craft-embedded-runtime']);
    expect(readFileSync(join(targetSkillDir, 'SKILL.md'), 'utf-8')).toBe('# User edit\n');
  });

  it('rejects unsafe manifest paths', () => {
    const seedDir = join(tempDir, 'resources', 'hermes-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'manifest.json'), JSON.stringify({
      skills: [
        {
          name: 'bad',
          source: '../outside',
          target: 'skills/craft/bad',
        },
      ],
    }));
    process.env.CRAFT_HERMES_HOME = join(tempDir, 'hermes-home');

    const result = ensureHermesSeedSkills();

    expect(result.copied).toEqual([]);
    expect(result.errors[0]).toContain('Unsafe Hermes seed relative path');
    expect(existsSync(join(tempDir, 'hermes-home', 'skills', 'craft', 'bad'))).toBe(false);
  });
});
