import { describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { COMPUTER_USE_TOOL_NAMES } from './computer-use-tools.ts';

const CRAFT_RUNTIME_EXTENSION = 'src/platform/macos/craft-runtime-extension.js';
const vendoredPackageDir = join(import.meta.dir, 'pi-computer-use');

describe('isolated pi-computer-use runtime', () => {
  it('loads the prebundled extension outside the checkout without non-builtin imports', async () => {
    const runtimeExtensionPath = join(vendoredPackageDir, CRAFT_RUNTIME_EXTENSION);
    expect(existsSync(runtimeExtensionPath)).toBe(true);

    const isolatedRoot = mkdtempSync(join(tmpdir(), 'craft-pi-computer-use-isolated-'));
    const isolatedPackageDir = join(isolatedRoot, 'pi-computer-use');

    expect(isolatedPackageDir.startsWith(import.meta.dir)).toBe(false);

    try {
      const rebuiltRuntimePath = join(isolatedRoot, 'rebuild', 'craft-runtime-extension.js');
      mkdirSync(dirname(rebuiltRuntimePath), { recursive: true });
      const rebuild = Bun.spawn([
        process.execPath,
        'build',
        join(vendoredPackageDir, 'extensions/computer-use.ts'),
        `--outfile=${rebuiltRuntimePath}`,
        '--target=bun',
        '--format=esm',
        '--minify',
        '--external',
        '@earendil-works/pi-coding-agent',
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [rebuildExit, rebuildStderr] = await Promise.all([
        rebuild.exited,
        new Response(rebuild.stderr).text(),
      ]);
      expect(rebuildExit, rebuildStderr).toBe(0);

      const committedRuntimeSource = readFileSync(runtimeExtensionPath, 'utf8');
      expect(readFileSync(rebuiltRuntimePath, 'utf8')).toBe(committedRuntimeSource);

      for (const relativePath of [
        'package.json',
        'scripts/setup-helper.mjs',
        CRAFT_RUNTIME_EXTENSION,
      ]) {
        const destination = join(isolatedPackageDir, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(vendoredPackageDir, relativePath), destination);
      }

      expect(existsSync(join(isolatedRoot, 'node_modules'))).toBe(false);

      const runtimeSource = readFileSync(join(isolatedPackageDir, CRAFT_RUNTIME_EXTENSION), 'utf8');
      const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(runtimeSource);
      const builtinSpecifiers = new Set([
        ...builtinModules,
        ...builtinModules.map(moduleName => `node:${moduleName}`),
      ]);
      expect(imports.filter(record => !builtinSpecifiers.has(record.path))).toEqual([]);

      const runtimeModule = await import(
        `${pathToFileURL(join(isolatedPackageDir, CRAFT_RUNTIME_EXTENSION)).href}?isolated=${Date.now()}`
      ) as {
        CRAFT_COMPUTER_USE_PACKAGE_ROOT: string;
        CRAFT_SETUP_HELPER_SCRIPT: string;
      };
      const realIsolatedPackageDir = realpathSync(isolatedPackageDir);
      expect(runtimeModule.CRAFT_COMPUTER_USE_PACKAGE_ROOT).toBe(realIsolatedPackageDir);
      expect(runtimeModule.CRAFT_SETUP_HELPER_SCRIPT).toBe(
        join(realIsolatedPackageDir, 'scripts/setup-helper.mjs')
      );
      expect(existsSync(runtimeModule.CRAFT_SETUP_HELPER_SCRIPT)).toBe(true);

      const loader = new DefaultResourceLoader({
        cwd: isolatedRoot,
        agentDir: join(isolatedRoot, '.pi-agent'),
        additionalExtensionPaths: [isolatedPackageDir],
      });
      await loader.reload();

      const result = loader.getExtensions();
      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      expect(result.extensions[0]?.path.startsWith(isolatedPackageDir)).toBe(true);
      expect([...result.extensions[0]!.tools.keys()]).toEqual([...COMPUTER_USE_TOOL_NAMES]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
