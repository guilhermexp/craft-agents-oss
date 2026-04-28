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

export function normalizeHermesRuntimeConfig(runtime: HermesRuntimeConfig = {}): Required<Pick<HermesRuntimeConfig, 'command' | 'args' | 'hermesHome'>> {
  const defaults = resolveDefaultHermesPaths(homedir())

  // Bundled runtime (resolved in apps/electron/src/main/handlers/hermes-runtime.ts).
  // CRAFT_HERMES_PYTHON points at the venv's python binary; CRAFT_HERMES_ARGS
  // is the JSON-encoded argv (`["-m", "acp_adapter"]`). Passed via env vars so
  // shared code does not import `electron`.
  const bundledPython = process.env.CRAFT_HERMES_PYTHON?.trim()
  const bundledArgs = parseEnvArgs(process.env.CRAFT_HERMES_ARGS)

  const command =
    runtime.command?.trim() ||
    bundledPython ||
    process.env.CRAFT_HERMES_COMMAND?.trim() ||
    'hermes'

  const explicitArgs = runtime.args && runtime.args.length > 0 ? runtime.args : null
  const args =
    explicitArgs ||
    // Use bundled argv only when we are also using the bundled Python; pairing
    // ['-m', 'acp_adapter'] with an external `hermes` binary would crash.
    (command === bundledPython ? bundledArgs : null) ||
    ['acp']

  const hermesHome =
    runtime.hermesHome?.trim() ||
    process.env.CRAFT_HERMES_HOME?.trim() ||
    process.env.HERMES_HOME?.trim() ||
    defaults.hermesHome

  return { command, args, hermesHome }
}

function headersToAcp(headers?: Record<string, string>): AcpHeader[] {
  if (!headers) return []
  return Object.entries(headers)
    .filter(([name, value]) => Boolean(name.trim()) && typeof value === 'string')
    .map(([name, value]) => ({ name, value }))
}

function envToAcp(env?: Record<string, string>): AcpEnvVar[] {
  if (!env) return []
  return Object.entries(env)
    .filter(([name, value]) => Boolean(name.trim()) && typeof value === 'string')
    .map(([name, value]) => ({ name, value }))
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
}): HermesAcpMcpServer[] {
  const poolServerUrl = args.poolServerUrl?.trim()
  if (poolServerUrl) {
    return [{ type: 'http', name: 'craft-sources', url: poolServerUrl, headers: [] }]
  }

  return Object.entries(args.mcpServers ?? {})
    .map(([name, config]) => sdkMcpServerToHermesAcp(name, config))
}
