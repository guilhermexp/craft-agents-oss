import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import { mainLog } from '../logger.js'

export type HermesRuntimePaths = {
  /** Absolute path to bundled venv `python3`/`python.exe`. */
  python: string
  /** Args passed after the python binary (`-m acp_adapter`). */
  args: string[]
  /** App-scoped HERMES_HOME under userData. Isolated from any standalone `~/.hermes`. */
  hermesHome: string
  /** Source dir copied into the bundle (contains acp_adapter, agent/, ...). */
  hermesAgentRoot: string
  /** Bundled venv root (used to set VIRTUAL_ENV). */
  virtualEnv: string
  /** Bin dir prepended to PATH so subprocess sees bundled `rg`. */
  vendorBinDir: string
}

const VENV_BIN = process.platform === 'win32' ? 'Scripts' : 'bin'
const PY_NAME = process.platform === 'win32' ? 'python.exe' : 'python3'

function resolvePackagedVendorRoot(): string {
  return join(process.resourcesPath, 'app', 'vendor', 'hermes')
}

function firstExistingPath(candidates: string[]): string {
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

function devResourceCandidates(...segments: string[]): string[] {
  return [
    // Electron dev from the app package root.
    join(app.getAppPath(), 'resources', ...segments),
    // Monorepo dev launched from repository root.
    join(process.cwd(), 'apps', 'electron', 'resources', ...segments),
    // Dev command launched from apps/electron.
    join(process.cwd(), 'resources', ...segments),
    // Fallback for unusual compiled __dirname layouts.
    join(__dirname, '..', '..', 'resources', ...segments),
  ]
}

function resolveDevBundleRoot(): string {
  // Dev bundle produced by scripts/bundle-hermes.*
  return firstExistingPath(devResourceCandidates('vendor', 'hermes'))
}

function resolveDevSourceRoot(): string {
  // Current dev checkout layout: direct Hermes source clone with .venv.
  // This keeps development using the embedded Hermes runtime instead of silently
  // falling back to a user's standalone ~/.local/bin/hermes.
  return firstExistingPath(devResourceCandidates('vendor', 'hermes-agent'))
}

/**
 * uv-style relocatable venvs ship a `pyvenv.cfg` whose `home` line points at
 * the Python install. We bundle a relative `home = ../python/bin` value, but
 * Python's site initialization accepts only absolute paths reliably across
 * platforms. Rewrite to the current absolute path when it drifts (first launch
 * or after the app was moved).
 */
function ensurePyvenvHome(virtualEnv: string, pythonDir: string): void {
  const cfgPath = join(virtualEnv, 'pyvenv.cfg')
  if (!existsSync(cfgPath)) return

  const expectedHome = process.platform === 'win32' ? pythonDir : join(pythonDir, 'bin')

  try {
    const original = readFileSync(cfgPath, 'utf8')
    const lines = original.split(/\r?\n/)
    let changed = false
    const next = lines.map((line) => {
      if (!line.startsWith('home = ')) return line
      if (line === `home = ${expectedHome}`) return line
      changed = true
      return `home = ${expectedHome}`
    })
    if (changed) writeFileSync(cfgPath, next.join('\n'), 'utf8')
  } catch (err) {
    mainLog.warn('Failed to patch pyvenv.cfg', err)
  }
}

let cachedPaths: HermesRuntimePaths | null = null

export function getHermesRuntimePaths(): HermesRuntimePaths | null {
  if (cachedPaths) return cachedPaths

  const vendorRoot = app.isPackaged ? resolvePackagedVendorRoot() : resolveDevBundleRoot()
  let virtualEnv = join(vendorRoot, 'hermes-venv')
  let pythonDir = join(vendorRoot, 'python')
  let python = join(virtualEnv, VENV_BIN, PY_NAME)
  let hermesAgentRoot = join(vendorRoot, 'hermes-agent')
  let vendorBinDir = join(vendorRoot, 'bin')
  let shouldPatchPyvenvHome = true

  if (!existsSync(python) && !app.isPackaged) {
    const sourceRoot = resolveDevSourceRoot()
    const sourceVirtualEnv = join(sourceRoot, '.venv')
    const sourcePython = join(sourceVirtualEnv, VENV_BIN, PY_NAME)
    if (existsSync(sourcePython) && existsSync(join(sourceRoot, 'acp_adapter'))) {
      virtualEnv = sourceVirtualEnv
      pythonDir = sourceVirtualEnv
      python = sourcePython
      hermesAgentRoot = sourceRoot
      vendorBinDir = join(sourceVirtualEnv, VENV_BIN)
      shouldPatchPyvenvHome = false
    }
  }

  if (!existsSync(python)) {
    mainLog.warn('Bundled Hermes Python missing; HermesAgent will fall back to PATH', {
      expected: python,
      vendorRoot,
      devSourceRoot: app.isPackaged ? undefined : resolveDevSourceRoot(),
    })
    return null
  }

  if (shouldPatchPyvenvHome) {
    ensurePyvenvHome(virtualEnv, pythonDir)
  }

  const hermesHome = join(app.getPath('userData'), 'hermes')
  if (!existsSync(hermesHome)) mkdirSync(hermesHome, { recursive: true })

  const paths: HermesRuntimePaths = {
    python,
    args: ['-m', 'acp_adapter'],
    hermesHome,
    hermesAgentRoot,
    virtualEnv,
    vendorBinDir,
  }

  cachedPaths = paths
  return paths
}

/**
 * Publish the resolved paths as env vars so shared backend code
 * (`packages/shared/src/hermes/acp-config.ts`) can pick them up without
 * importing `electron`.
 */
export function publishHermesRuntimeEnv(): void {
  const paths = getHermesRuntimePaths()
  if (!paths) return

  process.env.CRAFT_HERMES_PYTHON = paths.python
  process.env.CRAFT_HERMES_ARGS = JSON.stringify(paths.args)
  process.env.CRAFT_HERMES_HOME = paths.hermesHome
  process.env.CRAFT_HERMES_AGENT_ROOT = paths.hermesAgentRoot
  process.env.CRAFT_HERMES_VIRTUAL_ENV = paths.virtualEnv
  process.env.CRAFT_HERMES_VENDOR_BIN = paths.vendorBinDir

  if (existsSync(paths.vendorBinDir)) {
    const sep = process.platform === 'win32' ? ';' : ':'
    if (!process.env.PATH?.startsWith(paths.vendorBinDir)) {
      process.env.PATH = `${paths.vendorBinDir}${sep}${process.env.PATH ?? ''}`
    }
  }

  mainLog.info('Hermes bundled runtime resolved', {
    python: paths.python,
    hermesHome: paths.hermesHome,
  })
}

// Silence unused warning for dirname helper if tree-shaken.
void dirname
