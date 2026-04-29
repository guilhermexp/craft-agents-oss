import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'

import type {
  DriverBuildArgs,
  DriverFetchModelsArgs,
  DriverValidateStoredConnectionArgs,
  ProviderDriver,
  StoredConnectionValidationResult,
} from '../driver-types.ts'
import { normalizeHermesRuntimeConfig } from '../../../../hermes/acp-config.ts'
import { parseHermesConfigSnapshot } from '../../../../hermes/runtime-config.ts'

const execFile = promisify(execFileCb)

async function resolveHermesCommand(command: string): Promise<string | undefined> {
  try {
    const result = process.platform === 'win32'
      ? await execFile('where', [command])
      : await execFile('sh', ['-lc', `command -v ${command}`])

    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

function buildHermesRuntimeConfig() {
  return normalizeHermesRuntimeConfig()
}

async function validateHermesRuntime(): Promise<StoredConnectionValidationResult> {
  const runtime = buildHermesRuntimeConfig()
  const commandExists = isAbsolute(runtime.command)
    ? existsSync(runtime.command)
    : Boolean(await resolveHermesCommand(runtime.command))

  if (!commandExists) {
    return { success: false, error: `Hermes runtime not found: ${runtime.command}` }
  }

  return { success: true }
}

export const hermesDriver: ProviderDriver = {
  provider: 'hermes',
  async fetchModels(_args: DriverFetchModelsArgs) {
    const runtime = buildHermesRuntimeConfig()
    if (!existsSync(runtime.configPath)) {
      return { models: [], defaultModel: undefined }
    }

    const rawConfig = await readFile(runtime.configPath, 'utf-8')
    const snapshot = parseHermesConfigSnapshot(rawConfig)
    const models = Array.from(
      new Set(
        [snapshot.defaultModel, snapshot.fallbackModel, ...snapshot.customProviders.map(provider => provider.model)]
          .filter((model): model is string => Boolean(model))
          .map(id => ({
            id,
            name: id,
            shortName: id.split('/').pop() || id,
            description: 'Model discovered from Hermes config',
            provider: 'hermes' as const,
            contextWindow: 200_000,
          })),
      ),
    )

    return {
      models,
      defaultModel: snapshot.defaultModel,
    }
  },
  async validateStoredConnection(_args: DriverValidateStoredConnectionArgs) {
    return validateHermesRuntime()
  },
  buildRuntime(_args: DriverBuildArgs) {
    return buildHermesRuntimeConfig()
  },
}
