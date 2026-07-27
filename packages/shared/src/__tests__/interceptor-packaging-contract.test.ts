import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyPiAgentServer, type BuildConfig } from '../../../../scripts/build/common.ts';
import { resolveBackendRuntimePaths } from '../agent/backend/internal/runtime-resolver.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor packaging contract', () => {
  it('includes interceptor-request-utils.ts in all packaging manifests/scripts', () => {
    const builderYml = readRepoFile('apps/electron/electron-builder.yml');
    const dmgScript = readRepoFile('apps/electron/scripts/build-dmg.sh');
    const linuxScript = readRepoFile('apps/electron/scripts/build-linux.sh');
    const winScript = readRepoFile('apps/electron/scripts/build-win.ps1');

    expect(builderYml).toContain('packages/shared/src/interceptor-request-utils.ts');
    expect(dmgScript).toContain('interceptor-request-utils.ts');
    expect(linuxScript).toContain('interceptor-request-utils.ts');
    expect(winScript).toContain('interceptor-request-utils.ts');
  });

  it('syncs packaged session/pi subprocesses into dist resources during asset copy', () => {
    const copyAssetsScript = readRepoFile('apps/electron/scripts/copy-assets.ts');

    expect(copyAssetsScript).toContain('copyBundledSubprocessResources');
  });

  it('stages interceptor sources under dist/ in scripts while the manifest reads the canonical workspace-root source', () => {
    const builderYml = readRepoFile('apps/electron/electron-builder.yml');
    const dmgScript = readRepoFile('apps/electron/scripts/build-dmg.sh');
    const linuxScript = readRepoFile('apps/electron/scripts/build-linux.sh');
    const winScript = readRepoFile('apps/electron/scripts/build-win.ps1');

    // Packaging must stage into the gitignored dist/ output tree, never into
    // apps/electron/packages/ (which the dev runtime resolver searches and
    // would shadow the canonical workspace-root source with a stale copy).
    expect(dmgScript).toContain('dist/packages/shared/src');
    expect(linuxScript).toContain('dist/packages/shared/src');
    expect(winScript).toContain('dist\\packages\\shared\\src');
    expect(dmgScript).not.toContain('"$ELECTRON_DIR/packages/shared/src"');
    expect(linuxScript).not.toContain('"$ELECTRON_DIR/packages/shared/src"');
    expect(winScript).not.toContain('"$ElectronDir\\packages\\shared\\src"');

    // The manifest reads the canonical workspace-root source directly: CI
    // packaging (electron:dist:*) never runs the build-*.sh staging step, so a
    // dist/ `from:` would silently ship an empty interceptor (electron-builder
    // only warns on a missing source). The scripts still stage into dist/
    // (never apps/electron/packages/) so a dev run cannot shadow the canonical
    // workspace-root source.
    expect(builderYml).toContain('from: ../../packages/shared/src/unified-network-interceptor.ts');
    expect(builderYml).not.toContain('from: dist/packages/shared/src/unified-network-interceptor.ts');
  });
});

describe('dev interceptor resolution shields against stale apps/electron/packages copies', () => {
  let fixtureRoot = '';

  afterEach(() => {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = '';
    }
  });

  it('resolves the workspace-root source, not the stale apps/electron/packages copy', () => {
    // Mirror the real monorepo layout: a workspace-root source plus a stale,
    // gitignored copy under apps/electron/packages/ (what packaging scripts
    // used to mint). With appRootPath = apps/electron and isPackaged=false,
    // resolution must return the workspace-root file.
    fixtureRoot = mkdtempSync(join(tmpdir(), 'interceptor-shield-'));

    const canonicalDir = join(fixtureRoot, 'packages', 'shared', 'src');
    const canonical = join(canonicalDir, 'unified-network-interceptor.ts');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(canonical, '// canonical workspace-root source\n');

    const staleDir = join(fixtureRoot, 'apps', 'electron', 'packages', 'shared', 'src');
    const stale = join(staleDir, 'unified-network-interceptor.ts');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(stale, '// STALE build-output copy\n');

    const appRootPath = join(fixtureRoot, 'apps', 'electron');
    // A dev bundle must exist so a broken resolver has a real fallback to fall
    // back to — this keeps the assertion about the source path, not undefined.
    const bundleDir = join(appRootPath, 'dist');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'interceptor.cjs'), '// bundle\n');

    const paths = resolveBackendRuntimePaths({ appRootPath, isPackaged: false });

    // Fails if anyone reintroduces the level-0 upward search: that would return
    // `stale` because appRootPath is apps/electron.
    expect(paths.interceptorBundlePath).toBe(canonical);
    expect(paths.interceptorBundlePath).not.toBe(stale);
  });
});

const PI_COMPUTER_USE_V0_5_SENTINELS = [
  'package.json',
  'extensions/computer-use.ts',
  'src/contract.ts',
  'src/state.ts',
  'scripts/setup-helper.mjs',
  'prebuilt/macos/arm64/bridge',
  'skills/computer-use/SKILL.md',
] as const;

describe('Pi agent server packaging contract', () => {
  let packagingRoot = '';
  let resourcesDir = '';
  let buildConfig: BuildConfig;

  function writeFixtureFile(relativePath: string, content = 'fixture'): void {
    const filePath = join(packagingRoot, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  beforeEach(() => {
    packagingRoot = mkdtempSync(join(tmpdir(), 'craft-pi-packaging-'));
    resourcesDir = join(packagingRoot, 'resources');
    buildConfig = {
      platform: 'darwin',
      arch: 'arm64',
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: packagingRoot,
      electronDir: join(packagingRoot, 'apps', 'electron'),
    };

    writeFixtureFile('packages/pi-agent-server/dist/index.js');
    writeFixtureFile('packages/pi-agent-server/dist/pi-better-subagents/package.json');
    writeFixtureFile('packages/pi-agent-server/dist/pi-better-subagents/index.ts');
    for (const sentinel of PI_COMPUTER_USE_V0_5_SENTINELS) {
      writeFixtureFile(join('packages/pi-agent-server/dist/pi-computer-use', sentinel));
    }
    writeFixtureFile('node_modules/koffi/package.json', '{}');
    writeFixtureFile('node_modules/koffi/index.js');
    writeFixtureFile('node_modules/koffi/build/koffi/darwin_arm64/koffi.node');
  });

  afterEach(() => {
    rmSync(packagingRoot, { recursive: true, force: true });
  });

  it('preserves the pi-better-subagents extension during resource copy', () => {
    copyPiAgentServer(buildConfig, resourcesDir);

    expect(existsSync(join(resourcesDir, 'pi-agent-server/pi-better-subagents/package.json'))).toBe(true);
    expect(existsSync(join(resourcesDir, 'pi-agent-server/pi-better-subagents/index.ts'))).toBe(true);
  });

  it('copies every pi-computer-use v0.5 runtime sentinel', () => {
    copyPiAgentServer(buildConfig, resourcesDir);

    const missingSentinels = PI_COMPUTER_USE_V0_5_SENTINELS.filter(
      sentinel => !existsSync(join(resourcesDir, 'pi-agent-server/pi-computer-use', sentinel))
    );
    expect(missingSentinels).toEqual([]);
  });
});
