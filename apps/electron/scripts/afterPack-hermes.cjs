/* eslint-disable no-console */
/**
 * Hermes bundle post-pack cleanup + extraResources code-signing.
 *
 * 1. Walks the packaged app bundle (.app on macOS) under
 *    Contents/Resources/vendor/hermes and removes:
 *      - broken symlinks (codesign --verify rejects)
 *      - absolute symlinks pointing outside the bundle
 *      - fake .app directories without Info.plist
 * 2. Recreates the relative venv -> python symlink chain.
 * 3. Signs every Mach-O binary under the Hermes vendor dirs with the same
 *    identity electron-builder uses for the .app bundle.
 *
 * Called by `afterPack.cjs` (which also handles the macOS Liquid Glass icon).
 *
 * Replicates atomic-hermes/desktop/scripts/electron-builder.afterPack-sign-extra-resources.cjs.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (res.status !== 0) {
    const stderr = String(res.stderr || '').trim();
    const stdout = String(res.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${stderr || stdout || `exit ${res.status}`}`);
  }
  return String(res.stdout || '');
}

function findFirstAppBundle(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(dir, entry.name);
    }
  }
  return null;
}

function selectSigningIdentity() {
  const explicit =
    (process.env.CSC_NAME && String(process.env.CSC_NAME).trim()) ||
    (process.env.SIGN_IDENTITY && String(process.env.SIGN_IDENTITY).trim()) ||
    (process.env.CODESIGN_IDENTITY && String(process.env.CODESIGN_IDENTITY).trim());
  if (explicit) return explicit;

  let out;
  try {
    out = run('security', ['find-identity', '-p', 'codesigning', '-v'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const pickFirst = (re) => {
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  };

  return (
    pickFirst(/"([^"]*Developer ID Application[^"]*)"/) ||
    pickFirst(/"([^"]*Apple Distribution[^"]*)"/) ||
    pickFirst(/"([^"]*Apple Development[^"]*)"/) ||
    pickFirst(/"([^"]+)"/)
  );
}

function shouldTimestamp(identity) {
  return Boolean(identity) && identity !== '-' && identity.includes('Developer ID Application');
}

function isMachoBinary(filePath) {
  try {
    const out = run('/usr/bin/file', ['-b', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return out.includes('Mach-O');
  } catch {
    return false;
  }
}

function shouldConsiderForSigning(filePath, st) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.dylib' || ext === '.node' || ext === '.so') return true;
  if ((st.mode & 0o111) !== 0) return true;
  return false;
}

function walkFiles(rootDir, onFile) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) onFile(full);
    }
  }
}

function findEntitlements(projectDir) {
  for (const candidate of [
    'build/entitlements.mac.plist',
    'entitlements.mac.inherit.plist',
  ]) {
    const p = path.join(projectDir, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function codesignFile(filePath, identity, entitlements) {
  const args = ['--force', '--sign', identity];
  if (identity !== '-') args.push('--options', 'runtime');
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(shouldTimestamp(identity) ? '--timestamp' : '--timestamp=none');
  args.push(filePath);
  run('/usr/bin/codesign', args, { stdio: 'inherit' });
}

function cleanSymlinks(rootDir, appBundle) {
  let broken = 0;
  let absoluteFixed = 0;
  let outsideRemoved = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = fs.readlinkSync(full);
        } catch {
          continue;
        }
        const isAbsolute = path.isAbsolute(target);
        let exists = true;
        try {
          fs.statSync(full);
        } catch {
          exists = false;
        }
        const resolved = isAbsolute ? target : path.resolve(path.dirname(full), target);
        const outside = !resolved.startsWith(appBundle);

        if (!exists) {
          fs.unlinkSync(full);
          broken += 1;
        } else if (isAbsolute && outside) {
          fs.unlinkSync(full);
          outsideRemoved += 1;
        } else if (isAbsolute) {
          const rel = path.relative(path.dirname(full), resolved);
          try {
            fs.unlinkSync(full);
            fs.symlinkSync(rel, full);
            absoluteFixed += 1;
          } catch (err) {
            console.log(`[hermes] failed to convert symlink ${full}: ${err.message}`);
          }
        }
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };

  walk(rootDir);
  return { broken, absoluteFixed, outsideRemoved };
}

function renameFakeAppBundles(rootDir) {
  let renamed = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.app')) {
        const infoPlist = path.join(full, 'Contents', 'Info.plist');
        if (!fs.existsSync(infoPlist)) {
          fs.renameSync(full, full.replace(/\.app$/, '.app-dir'));
          renamed += 1;
          continue;
        }
      }
      stack.push(full);
    }
  }
  return renamed;
}

function ensureVenvSymlinks(hermesRoot) {
  const venvBin = path.join(hermesRoot, 'hermes-venv', 'bin');
  const pythonBin = path.join(hermesRoot, 'python', 'bin', 'python3');
  if (!fs.existsSync(venvBin) || !fs.existsSync(pythonBin)) return;

  const links = {
    python3: '../../python/bin/python3',
    python: 'python3',
    'python3.13': 'python3',
  };
  for (const [name, target] of Object.entries(links)) {
    const linkPath = path.join(venvBin, name);
    try {
      const existing = fs.readlinkSync(linkPath);
      if (existing === target) continue;
      fs.unlinkSync(linkPath);
    } catch {
      /* not a symlink or doesn't exist */
    }
    try {
      fs.symlinkSync(target, linkPath);
    } catch (err) {
      console.log(`[hermes] failed to create venv symlink ${name}: ${err.message}`);
    }
  }
}

module.exports = async function afterPackHermes(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appBundle = findFirstAppBundle(context.appOutDir);
  if (!appBundle) {
    console.log('[hermes] afterPack: .app bundle not found, skipping Hermes cleanup');
    return;
  }

  const resourcesDir = path.join(appBundle, 'Contents', 'Resources');
  const hermesRoot = path.join(resourcesDir, 'app', 'vendor', 'hermes');
  if (!fs.existsSync(hermesRoot)) {
    console.log('[hermes] afterPack: vendor/hermes not present in bundle, skipping');
    return;
  }

  console.log(`[hermes] afterPack: cleaning ${hermesRoot}`);

  const { broken, absoluteFixed, outsideRemoved } = cleanSymlinks(hermesRoot, appBundle);
  console.log(
    `[hermes] symlinks: broken=${broken}, absolute->relative=${absoluteFixed}, outside-bundle=${outsideRemoved}`,
  );

  ensureVenvSymlinks(hermesRoot);

  const fakeApps = renameFakeAppBundles(hermesRoot);
  if (fakeApps > 0) console.log(`[hermes] renamed ${fakeApps} fake .app dirs`);

  const identity = selectSigningIdentity();
  if (!identity) {
    console.log('[hermes] no codesign identity available, skipping Mach-O signing');
    return;
  }

  const entitlements = findEntitlements(context.packager.projectDir);
  console.log(`[hermes] signing with identity: ${identity}`);
  if (entitlements) console.log(`[hermes] entitlements: ${path.basename(entitlements)}`);

  let considered = 0;
  let signed = 0;
  for (const sub of ['python', 'hermes-venv', 'bin']) {
    const root = path.join(hermesRoot, sub);
    if (!fs.existsSync(root)) continue;
    walkFiles(root, (filePath) => {
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!shouldConsiderForSigning(filePath, st)) return;
      considered += 1;
      if (!isMachoBinary(filePath)) return;
      try {
        codesignFile(filePath, identity, entitlements);
        signed += 1;
      } catch (err) {
        console.log(`[hermes] codesign failed for ${filePath}: ${err.message}`);
      }
    });
  }

  console.log(`[hermes] signed ${signed} Mach-O files (considered ${considered})`);
};
