/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, rmSync } from 'fs';
import { relative, join, sep } from 'path';
import { copyBundledSubprocessResources, type Arch, type Platform } from '../../../scripts/build/common';

function resolvePlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function resolveArch(): Arch {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`Unsupported architecture: ${process.arch}`);
}

const rootDir = join(import.meta.dir, '..', '..', '..');
const electronDir = join(rootDir, 'apps', 'electron');
const distResourcesDir = join(electronDir, 'dist', 'resources');

const resourcesDir = join(electronDir, 'resources');

function shouldCopyResource(source: string): boolean {
  const resourceRelative = relative(resourcesDir, source).split(sep).join('/');
  // The Hermes Python runtime is large, symlink-heavy, and packaged through
  // electron-builder extraResources as app/vendor/hermes. Copying it into
  // dist/resources makes release builds duplicate the runtime and can break
  // electron-builder symlink handling. The legacy Hermes source checkout is a
  // dev-only fallback and must not ship via dist/resources either.
  return !(
    resourceRelative === 'vendor/hermes' ||
    resourceRelative.startsWith('vendor/hermes/') ||
    resourceRelative === 'vendor/hermes-agent' ||
    resourceRelative.startsWith('vendor/hermes-agent/')
  );
}

// Copy all runtime assets (icons, themes, docs, permissions, tool-icons, etc.).
// Exclude heavyweight/dev-only Hermes vendor directories; Hermes release runtime
// is included separately as app/vendor/hermes via electron-builder extraResources.
// Clear the generated dist/resources directory first so stale vendor copies from
// older builds cannot leak into release packages.
rmSync(distResourcesDir, { recursive: true, force: true });
cpSync(resourcesDir, distResourcesDir, { recursive: true, filter: shouldCopyResource });

console.log('✓ Copied resources/ → dist/resources/ (excluding Hermes vendor runtimes)');

copyBundledSubprocessResources({
  platform: resolvePlatform(),
  arch: resolveArch(),
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir,
  electronDir,
}, distResourcesDir);

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join(distResourcesDir, 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}
