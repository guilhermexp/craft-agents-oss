import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'

import {
  RPC_CHANNELS,
  type HermesDetectionResult,
} from '@craft-agent/shared/protocol'
import {
  parseHermesConfigSnapshot,
  resolveDefaultHermesPaths,
} from '@craft-agent/shared/hermes/runtime-config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const execFile = promisify(execFileCb)

async function resolveHermesBinary(command: string): Promise<string | undefined> {
  try {
    const lookup = process.platform === 'win32'
      ? await execFile('where', [command])
      : await execFile('sh', ['-lc', `command -v ${command}`])

    return lookup.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

async function resolveHermesVersion(commandPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFile(commandPath, ['--version'])
    return [stdout, stderr]
      .join('\n')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.hermes.DETECT_INSTALLATION,
] as const

export function registerHermesHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.hermes.DETECT_INSTALLATION, async (): Promise<HermesDetectionResult> => {
    const command = 'hermes'
    const defaultPaths = resolveDefaultHermesPaths(homedir())
    const resolvedCommand = await resolveHermesBinary(command)

    if (!resolvedCommand) {
      return {
        found: false,
        command,
        hermesHome: process.env.HERMES_HOME?.trim() || defaultPaths.hermesHome,
        configPath: defaultPaths.configPath,
        envPath: defaultPaths.envPath,
        providers: [],
        models: [],
        customProviders: [],
        error: 'Hermes nao encontrado no PATH.',
      }
    }

    const hermesHome = process.env.HERMES_HOME?.trim() || defaultPaths.hermesHome
    const configPath = existsSync(defaultPaths.configPath)
      ? defaultPaths.configPath
      : resolveDefaultHermesPaths(hermesHome.replace(/\/\.hermes$/, '')).configPath
    const envPath = existsSync(defaultPaths.envPath)
      ? defaultPaths.envPath
      : resolveDefaultHermesPaths(hermesHome.replace(/\/\.hermes$/, '')).envPath

    const rawConfig = existsSync(configPath)
      ? await readFile(configPath, 'utf-8')
      : ''
    const configSnapshot = parseHermesConfigSnapshot(rawConfig)
    const models = Array.from(
      new Set(
        [configSnapshot.defaultModel, configSnapshot.fallbackModel, ...configSnapshot.customProviders.map(provider => provider.model)]
          .filter((model): model is string => Boolean(model)),
      ),
    )

    deps.platform.logger?.info?.('[Hermes] Runtime detection complete', {
      found: true,
      resolvedCommand,
      configPath,
      providerCount: configSnapshot.providers.length,
      modelCount: models.length,
    })

    return {
      found: true,
      command,
      resolvedCommand,
      version: await resolveHermesVersion(resolvedCommand),
      hermesHome,
      configPath,
      envPath,
      defaultModel: configSnapshot.defaultModel,
      fallbackModel: configSnapshot.fallbackModel,
      providers: configSnapshot.providers,
      models,
      customProviders: configSnapshot.customProviders,
    }
  })
}
