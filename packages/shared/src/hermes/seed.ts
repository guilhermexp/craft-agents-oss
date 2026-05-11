import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { getBundledAssetsDir } from '../utils/paths.ts';

type SeedSkillManifestEntry = {
  name: string;
  source: string;
  target: string;
  mergePolicy?: 'copy-if-missing';
  description?: string;
};

type HermesSeedManifest = {
  version?: number;
  skills?: SeedSkillManifestEntry[];
};

export type HermesSeedResult = {
  hermesHome?: string;
  seedDir?: string;
  copied: string[];
  skipped: string[];
  errors: string[];
};

function readManifest(seedDir: string): SeedSkillManifestEntry[] {
  const manifestPath = join(seedDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as HermesSeedManifest;
    return parsed.skills ?? [];
  }

  const skillsDir = join(seedDir, 'skills');
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      source: `skills/${entry.name}`,
      target: `skills/craft/${entry.name}`,
      mergePolicy: 'copy-if-missing' as const,
    }));
}

function assertSafeRelativePath(path: string): void {
  const segments = path.split('/');
  if (!path || isAbsolute(path) || path.includes('\\') || segments.includes('..')) {
    throw new Error(`Unsafe Hermes seed relative path: ${path}`);
  }
}

/**
 * Copy repository-bundled Craft Hermes seed skills into app-scoped HERMES_HOME.
 *
 * This intentionally uses copy-if-missing semantics only: bundled seed knowledge
 * should make new installs useful, but must not overwrite user-edited skills.
 * Future versioned migrations can build on manifest.json without changing this
 * first-run behavior.
 */
export function ensureHermesSeedSkills(options: { hermesHome?: string } = {}): HermesSeedResult {
  const result: HermesSeedResult = { copied: [], skipped: [], errors: [] };
  const hermesHome = options.hermesHome ?? process.env.CRAFT_HERMES_HOME;
  result.hermesHome = hermesHome;

  if (!hermesHome) {
    result.errors.push('CRAFT_HERMES_HOME is not set; cannot seed embedded Hermes skills');
    return result;
  }

  const seedDir = getBundledAssetsDir('hermes-seed');
  result.seedDir = seedDir;
  if (!seedDir) {
    result.skipped.push('No bundled hermes-seed directory found');
    return result;
  }

  let entries: SeedSkillManifestEntry[] = [];
  try {
    entries = readManifest(seedDir);
  } catch (error) {
    result.errors.push(`Failed to read hermes-seed manifest: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const entry of entries) {
    try {
      assertSafeRelativePath(entry.source);
      assertSafeRelativePath(entry.target);

      const sourcePath = join(seedDir, entry.source);
      const targetPath = join(hermesHome, entry.target);

      if (!existsSync(sourcePath)) {
        result.errors.push(`Seed skill source missing: ${entry.source}`);
        continue;
      }

      if (existsSync(targetPath)) {
        result.skipped.push(entry.name || basename(targetPath));
        continue;
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: false });
      result.copied.push(entry.name || basename(targetPath));
    } catch (error) {
      result.errors.push(`Failed to seed ${entry.name || entry.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
