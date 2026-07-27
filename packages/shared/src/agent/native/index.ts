import type { AgentBackend } from '../backend/types.ts'
import type {
  AgentProvider,
  BackendHostRuntimeContext,
  CoreBackendConfig,
} from '../backend/types.ts'
import { ClaudeAgent } from '../claude-agent.ts'
import { PiAgent } from '../pi-agent.ts'
import type {
  BackendProviderOptions,
  BackendResolutionContext,
  DriverBuildArgs,
  DriverFetchModelsArgs,
  DriverHostRuntimeArgs,
  DriverTestConnectionArgs,
  DriverValidateStoredConnectionArgs,
  ProviderDriver,
  ResolvedBackendConfig,
  StoredConnectionValidationResult,
} from '../backend/internal/driver-types.ts'
import { getDefaultProviderType } from '../backend/internal/driver-types.ts'
import {
  resolveBackendRuntimePaths,
  type ResolvedBackendRuntimePaths,
} from '../backend/internal/runtime-resolver.ts'
import { anthropicDriver } from '../backend/internal/drivers/anthropic.ts'
import { piDriver } from '../backend/internal/drivers/pi.ts'
import {
  ensureDefaultClaudeConfigValid,
  type ClaudeConfigManager,
} from './claude-config-manager.ts'
import type { ModelFetchResult } from '../../config/model-fetcher.ts'

export { ensureDefaultClaudeConfigValid } from './claude-config-manager.ts'

export type NativeAgentProvider = Extract<AgentProvider, 'anthropic' | 'pi'>

export interface NativeAgentSpawnConfig {
  context: BackendResolutionContext & { provider: NativeAgentProvider }
  coreConfig: CoreBackendConfig
  hostRuntime: BackendHostRuntimeContext
  providerOptions?: BackendProviderOptions
}

export interface NativeAgentRuntime {
  spawn(config: NativeAgentSpawnConfig): AgentBackend
}

const NATIVE_DRIVER_REGISTRY: Record<NativeAgentProvider, ProviderDriver> = {
  anthropic: anthropicDriver,
  pi: piDriver,
}

export function isNativeAgentProvider(provider: AgentProvider): provider is NativeAgentProvider {
  return provider === 'anthropic' || provider === 'pi'
}

export function getAvailableNativeAgentProviders(): NativeAgentProvider[] {
  return ['anthropic', 'pi']
}

export function getNativeProviderDriver(provider: NativeAgentProvider): ProviderDriver {
  const driver = NATIVE_DRIVER_REGISTRY[provider]
  if (!driver) {
    throw new Error(`No native backend driver registered for provider: ${provider}`)
  }
  return driver
}

export function resolveNativeDriverRuntime(
  provider: NativeAgentProvider,
  hostRuntime: BackendHostRuntimeContext,
): { driver: ProviderDriver; resolvedPaths: ResolvedBackendRuntimePaths } {
  const driver = getNativeProviderDriver(provider)
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime)
  return { driver, resolvedPaths }
}

function createNativeBackend(config: ResolvedBackendConfig): AgentBackend {
  switch (config.provider) {
    case 'anthropic':
      return new ClaudeAgent(config)
    case 'pi':
      return new PiAgent(config)
    default:
      throw new Error(`Provider is not part of the native agent runtime: ${config.provider}`)
  }
}

class DefaultNativeAgentRuntime implements NativeAgentRuntime {
  spawn(config: NativeAgentSpawnConfig): AgentBackend {
    const { context, coreConfig, hostRuntime, providerOptions } = config
    const { driver, resolvedPaths } = resolveNativeDriverRuntime(context.provider, hostRuntime)

    const buildArgs: DriverBuildArgs = {
      context,
      coreConfig,
      hostRuntime,
      resolvedPaths,
      providerOptions,
    }

    driver.prepareRuntime?.(buildArgs)
    const runtime = driver.buildRuntime(buildArgs)

    const backendConfig: ResolvedBackendConfig = {
      ...coreConfig,
      provider: context.provider,
      providerType: context.connection?.providerType ?? getDefaultProviderType(context.provider),
      authType: context.authType,
      model: context.resolvedModel,
      connectionSlug: context.connection?.slug,
      runtime,
    }

    return createNativeBackend(backendConfig)
  }
}

export function createNativeAgentRuntime(): NativeAgentRuntime {
  return new DefaultNativeAgentRuntime()
}

export function spawnNativeAgent(config: NativeAgentSpawnConfig): AgentBackend {
  return createNativeAgentRuntime().spawn(config)
}

export async function initializeNativeAgentHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext
  claudeConfigManager?: Pick<ClaudeConfigManager, 'ensureValid'>
}): Promise<void> {
  const { hostRuntime, claudeConfigManager } = args

  await (claudeConfigManager?.ensureValid() ?? ensureDefaultClaudeConfigValid())

  for (const provider of getAvailableNativeAgentProviders()) {
    const { driver, resolvedPaths } = resolveNativeDriverRuntime(provider, hostRuntime)
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths })
  }
}

export async function fetchNativeAgentModels(args: Omit<DriverFetchModelsArgs, 'resolvedPaths'>): Promise<ModelFetchResult> {
  const provider = args.connection.providerType === 'anthropic' ? 'anthropic' : 'pi'
  const { driver, resolvedPaths } = resolveNativeDriverRuntime(provider, args.hostRuntime)

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  })

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for native provider: ${provider}`)
  }

  return driver.fetchModels({ ...args, resolvedPaths })
}

export async function validateStoredNativeAgentConnection(
  args: Omit<DriverValidateStoredConnectionArgs, 'resolvedPaths'> & { provider: NativeAgentProvider },
): Promise<StoredConnectionValidationResult> {
  const { provider, ...rest } = args
  const { driver, resolvedPaths } = resolveNativeDriverRuntime(provider, rest.hostRuntime)

  driver.initializeHostRuntime?.({
    hostRuntime: rest.hostRuntime,
    resolvedPaths,
  })

  if (!driver.validateStoredConnection) {
    return { success: true }
  }

  return driver.validateStoredConnection({ ...rest, resolvedPaths })
}

export async function testNativeAgentConnection(
  args: Omit<DriverTestConnectionArgs, 'resolvedPaths'> & { provider: NativeAgentProvider },
): Promise<{ success: boolean; error?: string } | null> {
  const { provider, ...rest } = args
  const { driver, resolvedPaths } = resolveNativeDriverRuntime(provider, rest.hostRuntime)

  return driver.testConnection?.({ ...rest, provider, resolvedPaths }) ?? null
}

export function prepareNativeAgentRuntime(args: DriverHostRuntimeArgs & { provider: NativeAgentProvider }): void {
  const { provider, ...rest } = args
  const driver = getNativeProviderDriver(provider)
  driver.initializeHostRuntime?.(rest)
}
