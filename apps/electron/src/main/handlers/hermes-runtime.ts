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

function resolveVendorRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app', 'vendor', 'hermes')
  }
  // Dev: run from repo root, vendor lives under apps/electron/resources/vendor/hermes
  return join(__dirname, '..', '..', 'resources', 'vendor', 'hermes')
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

  const vendorRoot = resolveVendorRoot()
  const virtualEnv = join(vendorRoot, 'hermes-venv')
  const pythonDir = join(vendorRoot, 'python')
  const python = join(virtualEnv, VENV_BIN, PY_NAME)

  if (!existsSync(python)) {
    mainLog.warn('Bundled Hermes Python missing; HermesAgent will fall back to PATH', {
      expected: python,
      vendorRoot,
    })
    return null
  }

  ensurePyvenvHome(virtualEnv, pythonDir)

  const hermesHome = join(app.getPath('userData'), 'hermes')
  if (!existsSync(hermesHome)) mkdirSync(hermesHome, { recursive: true })

  const paths: HermesRuntimePaths = {
    python,
    args: ['-m', 'acp_adapter'],
    hermesHome,
    hermesAgentRoot: join(vendorRoot, 'hermes-agent'),
    virtualEnv,
    vendorBinDir: join(vendorRoot, 'bin'),
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
