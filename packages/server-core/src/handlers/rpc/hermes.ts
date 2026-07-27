/**
 * Hermes RPC handlers.
 *
 * Protocol adapter only. Runtime detection, dashboard lifecycle, provider/model
 * config, env CRUD, profiles, logs/files/skills browsing, and dashboard-delegated
 * dev update all live in HermesRuntimeManager. All state is app-scoped under
 * `HERMES_HOME`.
 */

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  HermesRuntimeManager,
  cleanupHermesDashboardOrphans,
  type HermesCreateProfileBody,
  type HermesPatchApiConfigBody,
} from '../../hermes/hermes-runtime-manager'

export { cleanupHermesDashboardOrphans }

/**
 * The manager built by the most recent {@link registerHermesHandlers} call.
 * Electron main uses this to tear the dashboard down at quit.
 */
let activeManager: HermesRuntimeManager | null = null

/**
 * Gracefully shut down the Hermes dashboard child (and its uvicorn worker fork)
 * owned by the active runtime manager. No-op when no dashboard was started.
 */
export async function shutdownHermesDashboard(timeoutMs = 3000): Promise<void> {
  await activeManager?.shutdownDashboard(timeoutMs)
}

export function registerHermesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const manager = new HermesRuntimeManager(deps)
  activeManager = manager
  manager.startAuthJsonWatcher()

  const h = RPC_NAMESPACES.hermes
  server.handle(h.DETECT_INSTALLATION, () => manager.detectInstallation())
  server.handle(h.GET_RUNTIME_DETAILS, () => manager.getRuntimeDetails())
  server.handle(h.START_DASHBOARD, () => manager.startDashboard())
  server.handle(h.UPDATE_RUNTIME, () => manager.updateRuntime())
  server.handle(h.LIST_LOGS, () => manager.listLogs())
  server.handle(h.READ_LOG, (_ctx, name: string) => manager.readLog(name))
  server.handle(h.LIST_HOME_FILES, (_ctx, target?: string) => manager.listHomeFiles(target))
  server.handle(h.LIST_SKILLS, () => manager.listSkills())
  server.handle(h.OPEN_PATH, (_ctx, target?: string) => manager.openPath(target))
  server.handle(h.GET_API_CONFIG, () => manager.getApiConfig())
  server.handle(h.PATCH_API_CONFIG, (_ctx, body: HermesPatchApiConfigBody) => manager.patchApiConfig(body))
  server.handle(h.GET_PROVIDER_MODELS, (_ctx, provider: string) => manager.getProviderModels(provider))
  server.handle(h.LIST_PROFILES, () => manager.listProfiles())
  server.handle(h.GET_ACTIVE_PROFILE, () => manager.getActiveProfile())
  server.handle(h.SET_ACTIVE_PROFILE, (_ctx, name: string) => manager.setActiveProfile(name))
  server.handle(h.CREATE_PROFILE, (_ctx, body: HermesCreateProfileBody) => manager.createProfile(body))
  server.handle(h.RENAME_PROFILE, (_ctx, name: string, newName: string) => manager.renameProfile(name, newName))
  server.handle(h.DELETE_PROFILE, (_ctx, name: string) => manager.deleteProfile(name))
  server.handle(h.GET_PROFILE_SETUP_COMMAND, (_ctx, name: string) => manager.getProfileSetupCommand(name))
  server.handle(h.GET_PROFILE_SOUL, (_ctx, name: string) => manager.getProfileSoul(name))
  server.handle(h.UPDATE_PROFILE_SOUL, (_ctx, name: string, content: string) => manager.updateProfileSoul(name, content))
  server.handle(h.LIST_ENV, () => manager.listEnv())
  server.handle(h.SET_ENV, (_ctx, body: { key: string; value: string }) => manager.setEnv(body.key, body.value))
  server.handle(h.DELETE_ENV, (_ctx, key: string) => manager.deleteEnv(key))
}
