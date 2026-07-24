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
