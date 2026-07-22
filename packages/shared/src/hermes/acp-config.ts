import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SdkMcpServerConfig } from '../agent/backend/types.ts'

type AcpHeader = { name: string; value: string }
type AcpEnvVar = { name: string; value: string }

export type HermesAcpMcpServer =
  | { type: 'http' | 'sse'; name: string; url: string; headers: AcpHeader[] }
  | { type: 'stdio'; name: string; command: string; args: string[]; env: AcpEnvVar[] }

export type HermesRuntimeConfig = {
  command?: string
  args?: string[]
  hermesHome?: string
  configPath?: string
  envPath?: string
}

export type NormalizedHermesRuntimeConfig = Required<HermesRuntimeConfig>

const HERMES_DEFAULT_PROFILE = 'default'
const HERMES_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function resolveDefaultHermesPaths(homeDir: string): {
  hermesHome: string
  configPath: string
  envPath: string
} {
  const hermesHome = join(homeDir, '.hermes')
  return {
    hermesHome,
    configPath: join(hermesHome, 'config.yaml'),
    envPath: join(hermesHome, '.env'),
  }
}

function parseEnvArgs(value: string | undefined): string[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed as string[]
    }
  } catch {
    // Fall back to whitespace split below for compatibility with simple values.
  }
  const parts = value.trim().split(/\s+/).filter(Boolean)
  return parts.length > 0 ? parts : null
}

const BUNDLED_REQUIRED_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isBundledHermesRequired(): boolean {
  return BUNDLED_REQUIRED_ENV_VALUES.has((process.env.CRAFT_HERMES_REQUIRE_BUNDLED ?? '').trim().toLowerCase())
}

export function normalizeHermesRuntimeConfig(runtime: HermesRuntimeConfig = {}): NormalizedHermesRuntimeConfig {
  const defaults = resolveDefaultHermesPaths(homedir())

  // A config de runtime Hermes e resolvida aqui, fora de agent/native.
  // Codigo nativo Claude/Pi nao deve inspecionar nem mutar HERMES_HOME,
  // paths de dashboard ou config ACP.

  // Bundled runtime (resolved in apps/electron/src/main/handlers/hermes-runtime.ts).
  // CRAFT_HERMES_PYTHON points at the venv's python binary; CRAFT_HERMES_ARGS
  // is the JSON-encoded argv (`["-m", "acp_adapter"]`). Passed via env vars so
  // shared code does not import `electron`.
  const bundledPython = process.env.CRAFT_HERMES_PYTHON?.trim()
  const bundledArgs = parseEnvArgs(process.env.CRAFT_HERMES_ARGS)
  const bundledRequired = isBundledHermesRequired()
  const missingBundledCommand = process.env.CRAFT_HERMES_MISSING_COMMAND?.trim() || 'craft-hermes-bundled-runtime-missing'

  // In packaged Craft builds Hermes is a managed, app-scoped runtime. If the
  // vendored Python is missing, fail closed instead of silently using a user's
  // standalone `hermes` from PATH (which would mix auth/config/memory state).
  const command = bundledRequired
    ? (bundledPython || missingBundledCommand)
    : (runtime.command?.trim() || bundledPython || process.env.CRAFT_HERMES_COMMAND?.trim() || 'hermes')

  const explicitArgs = !bundledRequired && runtime.args && runtime.args.length > 0 ? runtime.args : null
  const args =
    explicitArgs ||
    // Use bundled argv only when we are also using the bundled Python; pairing
    // ['-m', 'acp_adapter'] with an external `hermes` binary would crash.
    (command === bundledPython ? bundledArgs : null) ||
    (bundledRequired ? [] : ['acp'])

  const hermesHome =
    runtime.hermesHome?.trim() ||
    process.env.CRAFT_HERMES_HOME?.trim() ||
    process.env.HERMES_HOME?.trim() ||
    defaults.hermesHome

  const normalizedHome = hermesHome.replace(/[\\/]$/, '')
  const configPath = runtime.configPath?.trim() || join(normalizedHome, 'config.yaml')
  const envPath = runtime.envPath?.trim() || join(normalizedHome, '.env')

  return { command, args, hermesHome, configPath, envPath }
}

export function isValidHermesProfileName(name: string): boolean {
  return name === HERMES_DEFAULT_PROFILE || HERMES_PROFILE_NAME_RE.test(name)
}

export function applyHermesProfileToRuntime(
  runtime: NormalizedHermesRuntimeConfig,
  profileName?: string | null,
): NormalizedHermesRuntimeConfig {
  const name = profileName?.trim()
  if (!name || name === HERMES_DEFAULT_PROFILE || !isValidHermesProfileName(name)) {
    return runtime
  }

  const hermesHome = join(runtime.hermesHome, 'profiles', name)
  return {
    ...runtime,
    hermesHome,
    configPath: join(hermesHome, 'config.yaml'),
    envPath: join(hermesHome, '.env'),
  }
}

function headersToAcp(headers?: Record<string, string>): AcpHeader[] {
  if (!headers) return []
  return Object.entries(headers)
    .flatMap(([name, value]) =>
      Boolean(name.trim()) && typeof value === 'string'
        ? [{ name, value }]
        : [],
    )
}

function envToAcp(env?: Record<string, string>): AcpEnvVar[] {
  if (!env) return []
  return Object.entries(env)
    .flatMap(([name, value]) =>
      Boolean(name.trim()) && typeof value === 'string'
        ? [{ name, value }]
        : [],
    )
}

export function sdkMcpServerToHermesAcp(name: string, config: SdkMcpServerConfig): HermesAcpMcpServer {
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      name,
      command: config.command,
      args: config.args ?? [],
      env: envToAcp(config.env),
    }
  }

  return {
    type: config.type,
    name,
    url: config.url,
    headers: headersToAcp(config.headers),
  }
}

export function buildHermesAcpMcpServers(args: {
  mcpServers?: Record<string, SdkMcpServerConfig>
  poolServerUrl?: string
  sessionToolsServerUrl?: string
}): HermesAcpMcpServer[] {
  const sessionToolsServerUrl = args.sessionToolsServerUrl?.trim()
  const sessionToolsServer = sessionToolsServerUrl
    ? [{ type: 'http' as const, name: 'craft-session', url: sessionToolsServerUrl, headers: [] }]
    : []

  const poolServerUrl = args.poolServerUrl?.trim()
  if (poolServerUrl) {
    return [
      { type: 'http', name: 'craft-sources', url: poolServerUrl, headers: [] },
      ...sessionToolsServer,
    ]
  }

  return [
    ...Object.entries(args.mcpServers ?? {})
      .map(([name, config]) => sdkMcpServerToHermesAcp(name, config)),
    ...sessionToolsServer,
  ]
}
