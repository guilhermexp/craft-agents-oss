import { getCredentialManager } from '../credentials/index.ts';
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../workspaces/storage.ts';
import { debug } from '../utils/debug.ts';
import type { LlmConnection } from './llm-connections.ts';
import {
  isValidProviderAuthCombination,
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  isPiProvider,
  toBedrockNativeId,
  type LlmProviderType,
} from './llm-connections.ts';
import {
  getModelProvider,
  getModelById,
  getModelDisplayName,
  normalizeDeprecatedModelId,
  type ModelDefinition,
} from './models.ts';
import type { StoredConfig } from './storage.ts';
import { loadStoredConfig, saveConfig, getWorkspaces } from './storage.ts';
import type { AuthType } from '@craft-agent/core/types';

/**
 * Migrate Codex (OpenAI) and Copilot connections to Pi backend.
 * Runs on startup — transparently routes existing users through PiAgent.
 *
 * No re-auth needed: credentials are keyed by connection slug (not provider),
 * and PiAgent reads the same OAuth tokens via piAuthProvider.
 *
 * Migration rules:
 * - openai + oauth       → pi + openai-codex
 * - openai + api_key     → pi + openai
 * - openai_compat        → pi + openai  (keep baseUrl)
 * - copilot              → pi + github-copilot
 * - defaultModel reset to Pi's default (stale Codex/Copilot model IDs dropped)
 * - codexPath removed (no longer needed)
 */
function migrateCodexCopilotToPi(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;

  for (const connection of config.llmConnections) {
    // Cast to string for legacy providerType values that were removed from LlmProviderType
    // but may still exist on disk in old configs. Cast to any for legacy codexPath field.
    const providerStr = connection.providerType as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connAny = connection as any;
    if (providerStr === 'openai' && connection.authType === 'oauth') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai-codex';
      connection.name = 'ChatGPT Plus (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined; // reset — backfill picks Pi default
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai' && (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint')) {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      connection.name = 'OpenAI API (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai_compat') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      // keep baseUrl for custom endpoints
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'copilot') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'github-copilot';
      connection.name = 'GitHub Copilot (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    }
  }

  // Clean up openaiVariant config field (Codex-specific A/B testing, no longer relevant)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (configAny.openaiVariant) {
    delete configAny.openaiVariant;
    changed = true;
  }

  return changed;
}

/**
 * Backfill models and defaultModel on ALL connections.
 * Ensures built-in connections (anthropic, openai) always have models populated,
 * not just compat connections.
 */
export function shouldMigratePiOpenAiProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType' | 'baseUrl'>): boolean {
  // Legacy cleanup: old ChatGPT Plus OAuth connections may still be tagged as `openai`.
  // Only migrate those to `openai-codex`.
  //
  // IMPORTANT: Do NOT migrate API-key or custom-endpoint connections:
  // - `api_key` / `api_key_with_endpoint` with `openai` must remain regular OpenAI API auth.
  // - forcing them to `openai-codex` routes requests to ChatGPT backend auth and breaks on restart.
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai') return false;
  if (connection.authType !== 'oauth') return false;
  if (typeof connection.baseUrl === 'string' && connection.baseUrl.trim().length > 0) return false;
  return true;
}

export function shouldRepairPiApiKeyCodexProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType'>): boolean {
  // Repair broken state from previous startup migrations:
  // API-key connections tagged as `openai-codex` try ChatGPT backend JWT auth and fail.
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai-codex') return false;
  return connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint';
}

function normalizeModelIds(models?: Array<{ id: string } | string>): string[] {
  if (!models) return [];
  return models
    .map(m => typeof m === 'string' ? m : m.id)
    .filter((id): id is string => !!id && id.trim().length > 0);
}

function modelSetEquals(a: string[], b: string[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size !== bs.size) return false;
  for (const id of as) {
    if (!bs.has(id)) return false;
  }
  return true;
}

export function inferModelSelectionMode(
  connection: Pick<LlmConnection, 'models'>,
  providerDefaultModelIds: string[],
): 'automaticallySyncedFromProvider' | 'userDefined3Tier' {
  const currentIds = normalizeModelIds(connection.models);
  if (currentIds.length === 0) return 'automaticallySyncedFromProvider';
  return modelSetEquals(currentIds, providerDefaultModelIds)
    ? 'automaticallySyncedFromProvider'
    : 'userDefined3Tier';
}

function backfillAllConnectionModels(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;
  for (const connection of config.llmConnections) {
    // Repair previously broken API-key migration first.
    if (shouldRepairPiApiKeyCodexProvider(connection)) {
      connection.piAuthProvider = 'openai';
      changed = true;
    }

    // Migrate only legacy OAuth-backed Pi OpenAI connections to ChatGPT backend provider key.
    if (shouldMigratePiOpenAiProvider(connection)) {
      connection.piAuthProvider = 'openai-codex';
      changed = true;
    }

    const defaultModels = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
    const defaultModel = getDefaultModelForConnection(connection.providerType, connection.piAuthProvider);
    const providerDefaultModelIds = normalizeModelIds(defaultModels as Array<{ id: string } | string>);

    // Note: bedrock connections are migrated to pi + amazon-bedrock by migrateLegacyProviderTypes()
    // before this function runs, so no bedrock-specific normalization needed here.

    if (isPiProvider(connection.providerType) && connection.piAuthProvider) {
      // Copilot models are always server-managed (GitHub policy controls which
      // models are enabled), so force automaticallySyncedFromProvider regardless
      // of what inferModelSelectionMode would compute from stale static SDK data.
      const isCopilot = connection.piAuthProvider === 'github-copilot';
      const mode = isCopilot
        ? 'automaticallySyncedFromProvider' as const
        : (connection.modelSelectionMode ?? inferModelSelectionMode(connection, providerDefaultModelIds));
      if (connection.modelSelectionMode !== mode) {
        debug('[storage] backfill mode inferred', {
          slug: connection.slug,
          piAuthProvider: connection.piAuthProvider,
          from: connection.modelSelectionMode,
          to: mode,
          currentModelCount: normalizeModelIds(connection.models).length,
        });
        connection.modelSelectionMode = mode;
        changed = true;
      }

      if (mode === 'automaticallySyncedFromProvider') {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0 && !modelSetEquals(currentIds, providerDefaultModelIds)) {
          connection.models = defaultModels;
          changed = true;
        }
      } else {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0) {
          const allowedIds = new Set(providerDefaultModelIds);
          const canonicalCurrentIds = currentIds.map((id) => {
            if (allowedIds.has(id)) return id;
            if (!id.startsWith('pi/')) {
              const prefixed = `pi/${id}`;
              if (allowedIds.has(prefixed)) return prefixed;
            }
            return id;
          });
          const filtered = canonicalCurrentIds.filter(id => allowedIds.has(id));

          if (!modelSetEquals(canonicalCurrentIds, currentIds) || filtered.length !== currentIds.length) {
            debug('[storage] backfill userDefined filtered', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              beforeCount: currentIds.length,
              canonicalCount: canonicalCurrentIds.length,
              afterCount: filtered.length,
              beforeFirst5: currentIds.slice(0, 5),
              afterFirst5: filtered.slice(0, 5),
            });
            connection.models = filtered;
            changed = true;
          }

          if (filtered.length === 0) {
            debug('[storage] backfill userDefined fallback-to-defaults', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              defaultCount: providerDefaultModelIds.length,
            });
            connection.models = defaultModels;
            changed = true;
          }
        }
      }
    }

    if (defaultModels.length > 0 && (!connection.models || (Array.isArray(connection.models) && connection.models.length === 0))) {
      connection.models = defaultModels;
      changed = true;
    }

    if (!connection.defaultModel && defaultModel) {
      connection.defaultModel = defaultModel;
      changed = true;
    }

    // Validate that existing defaultModel is in the models list
    if (connection.defaultModel && connection.models && Array.isArray(connection.models) && connection.models.length > 0) {
      const modelIds = connection.models.map(m => typeof m === 'string' ? m : m.id);
      if (!modelIds.includes(connection.defaultModel)) {
        // Reset to first available model in the list
        const firstModelId = modelIds[0];
        if (firstModelId) {
          connection.defaultModel = firstModelId;
        }
        changed = true;
      }
    }
  }
  return changed;
}

const OPUS_DEFAULT_ID = 'claude-opus-4-8';
const OPUS_FALLBACK_ID = 'claude-opus-4-7';

function defaultModelIdsForConnection(connection: LlmConnection): Set<string> {
  return new Set(
    getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
      .map(model => typeof model === 'string' ? model : model.id),
  );
}

function normalizeConnectionModelId(connection: LlmConnection, modelId: string): string {
  const normalized = normalizeDeprecatedModelId(modelId);

  if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const native = toBedrockNativeId(bare);
    const defaults = defaultModelIdsForConnection(connection);
    const prefixedCandidate = `pi/${native}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : native;

    if (bare === OPUS_DEFAULT_ID || native.endsWith(`.${OPUS_DEFAULT_ID}`)) {
      const fallbackNative = toBedrockNativeId(OPUS_FALLBACK_ID);
      const prefixedFallback = `pi/${fallbackNative}`;
      const fallback = defaults.has(prefixedFallback) ? prefixedFallback : fallbackNative;
      if (!defaults.has(candidate) && defaults.has(fallback)) return fallback;
    }
    return candidate;
  }

  if (connection.providerType === 'pi') {
    const defaults = defaultModelIdsForConnection(connection);
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const prefixedCandidate = `pi/${bare}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : normalized;
    const prefixedFallback = `pi/${OPUS_FALLBACK_ID}`;
    const fallback = defaults.has(prefixedFallback) ? prefixedFallback : OPUS_FALLBACK_ID;
    if (bare === OPUS_DEFAULT_ID && !defaults.has(candidate) && defaults.has(fallback)) {
      return fallback;
    }
    if (bare === OPUS_DEFAULT_ID && candidate !== normalized) {
      return candidate;
    }
  }

  return normalized;
}

function displayNameForMigratedModel(modelId: string): string {
  const bareModelId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  return getModelDisplayName(bareModelId);
}

function withUpdatedModelEntry(
  connection: LlmConnection,
  entry: ModelDefinition | string,
  nextId: string,
): ModelDefinition | string {
  if (typeof entry === 'string') {
    if (connection.providerType === 'anthropic' && nextId === OPUS_DEFAULT_ID) {
      return { ...getModelById(OPUS_DEFAULT_ID)! };
    }
    return nextId;
  }

  const nextEntry: ModelDefinition = { ...entry, id: nextId };
  if (connection.providerType === 'anthropic' && nextId === OPUS_DEFAULT_ID) {
    return { ...getModelById(OPUS_DEFAULT_ID)! };
  }
  if (nextEntry.name && /Opus 4\.[56]/.test(nextEntry.name)) {
    nextEntry.name = displayNameForMigratedModel(nextId);
  }
  return nextEntry;
}

function modelEntryForDefault(connection: LlmConnection, modelId: string): ModelDefinition | string {
  if (connection.providerType === 'anthropic' && modelId === OPUS_DEFAULT_ID) {
    return { ...getModelById(OPUS_DEFAULT_ID)! };
  }
  return modelId;
}

/** Normalize deprecated Opus IDs while preserving provider-specific compatibility. */
function migrateLegacyOpusToDefaultOpus(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    if (connection.providerType !== 'anthropic' && connection.providerType !== 'pi') continue;

    if (connection.defaultModel) {
      let normalizedDefault = normalizeConnectionModelId(connection, connection.defaultModel);
      if (connection.providerType === 'anthropic' && normalizedDefault === OPUS_FALLBACK_ID) {
        normalizedDefault = OPUS_DEFAULT_ID;
      }
      if (normalizedDefault !== connection.defaultModel) {
        connection.defaultModel = normalizedDefault;
        changed = true;
      }
    }

    if (connection.models && Array.isArray(connection.models)) {
      const nextModels: Array<ModelDefinition | string> = [];
      const seen = new Set<string>();
      let connectionModelsChanged = false;

      for (const entry of connection.models) {
        const currentId = typeof entry === 'string' ? entry : entry.id;
        const nextId = normalizeConnectionModelId(connection, currentId);

        if (seen.has(nextId)) {
          connectionModelsChanged = true;
          continue;
        }
        seen.add(nextId);

        if (nextId !== currentId) {
          nextModels.push(withUpdatedModelEntry(connection, entry, nextId));
          connectionModelsChanged = true;
        } else {
          nextModels.push(entry);
        }
      }

      if (connection.defaultModel && !seen.has(connection.defaultModel)) {
        nextModels.unshift(modelEntryForDefault(connection, connection.defaultModel));
        connectionModelsChanged = true;
      }

      if (connectionModelsChanged) {
        connection.models = nextModels;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Migrate Sonnet 4.5 to Sonnet 4.6 for direct Anthropic connections.
 * Same pattern as migrateOpus45ToOpus46 — updates stored model IDs and names.
 */
function migrateSonnet45ToSonnet46(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  const SONNET_45_ID = 'claude-sonnet-4-5-20250929';
  const SONNET_46_ID = 'claude-sonnet-4-6';

  let changed = false;

  for (const connection of config.llmConnections) {
    // Only migrate direct Anthropic connections (not compat/third-party)
    if (connection.providerType !== 'anthropic') continue;

    // Migrate defaultModel
    if (connection.defaultModel === SONNET_45_ID) {
      connection.defaultModel = SONNET_46_ID;
      changed = true;
    }

    // Migrate models array
    if (connection.models && Array.isArray(connection.models)) {
      const hasNew = connection.models.some(m =>
        (typeof m === 'string' ? m : m.id) === SONNET_46_ID
      );

      if (hasNew) {
        // New model already exists — just remove the old entry to avoid duplicates
        const before = connection.models.length;
        connection.models = connection.models.filter(m =>
          (typeof m === 'string' ? m : m.id) !== SONNET_45_ID
        );
        if (connection.models.length !== before) changed = true;
      } else {
        // New model doesn't exist — rename the old entry in place
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string' && model === SONNET_45_ID) {
            connection.models[i] = SONNET_46_ID;
            changed = true;
          } else if (typeof model === 'object' && model.id === SONNET_45_ID) {
            model.id = SONNET_46_ID;
            if (model.name?.includes('4.5')) {
              model.name = model.name.replace('4.5', '4.6');
            }
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

/**
 * Migrate Sonnet 4.5 to Sonnet 4.6 in workspace default models.
 */
function migrateWorkspaceSonnet45ToSonnet46(config: StoredConfig): void {
  if (!config.workspaces) return;

  const SONNET_45_ID = 'claude-sonnet-4-5-20250929';
  const SONNET_46_ID = 'claude-sonnet-4-6';

  for (const workspace of config.workspaces) {
    const wsConfig = loadWorkspaceConfig(workspace.rootPath);
    if (!wsConfig?.defaults?.model) continue;

    if (wsConfig.defaults.model === SONNET_45_ID) {
      wsConfig.defaults.model = SONNET_46_ID;
      saveWorkspaceConfig(workspace.rootPath, wsConfig);
    }
  }
}

/** Migrate deprecated/previous Opus workspace defaults to the current default. */
function migrateWorkspaceLegacyOpusToDefaultOpus(config: StoredConfig): void {
  if (!config.workspaces) return;

  for (const workspace of config.workspaces) {
    const wsConfig = loadWorkspaceConfig(workspace.rootPath);
    if (!wsConfig?.defaults?.model) continue;

    const normalized = normalizeDeprecatedModelId(wsConfig.defaults.model);
    const nextModel = normalized === OPUS_FALLBACK_ID ? OPUS_DEFAULT_ID : normalized;
    if (nextModel !== wsConfig.defaults.model) {
      wsConfig.defaults.model = nextModel;
      saveWorkspaceConfig(workspace.rootPath, wsConfig);
    }
  }
}

/**
 * Migrate legacy provider types to the active set (anthropic, pi, pi_compat).
 *
 * 1. providerType==='bedrock' → 'pi' with piAuthProvider='amazon-bedrock'.
 *    Model IDs are normalized to Bedrock-native (pi-prefixed) for Pi SDK resolution.
 *
 * 2. providerType==='vertex' → 'pi' with piAuthProvider='google-vertex'.
 *
 * 3. providerType==='anthropic_compat' → 'pi_compat' with customEndpoint.api='anthropic-messages'.
 *    Preserves baseUrl and models; authType 'api_key_with_endpoint' stays the same.
 *
 * Also normalizes Pi+Bedrock connections that already have correct providerType.
 */
function migrateLegacyProviderTypes(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    // Cast to string for legacy values removed from LlmProviderType
    const providerStr = connection.providerType as string;

    // --- bedrock → pi + amazon-bedrock ---
    if (providerStr === 'bedrock') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = connection.piAuthProvider || 'amazon-bedrock';
      // Normalize model IDs to Bedrock-native (pi-prefixed) for Pi SDK
      if (connection.defaultModel) {
        connection.defaultModel = normalizePiBedrockId(connection.defaultModel);
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            connection.models[i] = normalizePiBedrockId(model);
          } else if (model && typeof model === 'object') {
            model.id = normalizePiBedrockId(model.id);
          }
        }
      }
      changed = true;
      continue;
    }

    // --- vertex → pi + google-vertex ---
    if (providerStr === 'vertex') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = 'google-vertex';
      changed = true;
      continue;
    }

    // --- anthropic_compat → pi_compat + customEndpoint ---
    if (providerStr === 'anthropic_compat') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi_compat';
      connection.customEndpoint = { api: 'anthropic-messages' };
      // authType 'api_key_with_endpoint' stays; baseUrl and models are preserved
      changed = true;
      continue;
    }

    // Forward: Pi+Bedrock connections need Bedrock-native IDs (pi-prefixed) for Pi SDK resolution
    if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
      if (connection.defaultModel) {
        const normalized = normalizePiBedrockId(connection.defaultModel);
        if (normalized !== connection.defaultModel) {
          connection.defaultModel = normalized;
          changed = true;
        }
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            const normalized = normalizePiBedrockId(model);
            if (normalized !== model) { connection.models[i] = normalized; changed = true; }
          } else if (model && typeof model === 'object') {
            const normalized = normalizePiBedrockId(model.id);
            if (normalized !== model.id) { model.id = normalized; changed = true; }
          }
        }
      }
    }
  }

  return changed;
}

/** Normalize a pi/-prefixed model ID for Bedrock: pi/claude-opus-4-7 → pi/anthropic.claude-opus-4-7-v1 */
function normalizePiBedrockId(id: string): string {
  if (id.startsWith('pi/')) {
    const bare = id.slice(3);
    const native = toBedrockNativeId(bare);
    return native !== bare ? `pi/${native}` : id;
  }
  return id;
}

/**
 * Rename legacy `hermes-local` connection slug to `hermes`. There is only one
 * Hermes (the embedded runtime) — the `-local` suffix was redundant and caused
 * confusion alongside `claude-max` / `chatgpt-plus`, which never carried an
 * external/local distinction either.
 */
function migrateHermesLocalSlug(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    if (connection.slug === 'hermes-local') {
      // Drop a duplicate if migration already created the new entry.
      if (config.llmConnections.some(c => c.slug === 'hermes')) {
        continue;
      }
      connection.slug = 'hermes';
      changed = true;
    }
    // Strip the legacy "(Local)" suffix from any existing Hermes connection,
    // including the one whose slug was already migrated above. There is only
    // one Hermes (the embedded runtime) — the suffix is misleading.
    if (
      connection.providerType === 'hermes' &&
      typeof connection.name === 'string' &&
      /\bhermes\b/i.test(connection.name) &&
      /\blocal\b/i.test(connection.name)
    ) {
      connection.name = 'Hermes';
      changed = true;
    }
  }

  if (changed) {
    config.llmConnections = config.llmConnections.filter(
      (c, i, arr) => arr.findIndex(x => x.slug === c.slug) === i,
    );
  }

  // Workspace-scoped defaults may reference the old slug.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (configAny.workspaces && typeof configAny.workspaces === 'object') {
    for (const ws of Object.values(configAny.workspaces) as Array<Record<string, unknown>>) {
      if (ws && typeof ws === 'object' && ws.defaultLlmConnection === 'hermes-local') {
        ws.defaultLlmConnection = 'hermes';
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults.
 * If user had set modelDefaults.anthropic, apply it to the default anthropic connection.
 * Same for openai. Then remove modelDefaults from config.
 */
function migrateModelDefaultsToConnections(config: StoredConfig): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (!configAny.modelDefaults || !config.llmConnections) return false;
  let changed = false;

  // Apply anthropic model default to the default anthropic connection
  if (configAny.modelDefaults.anthropic) {
    const defaultSlug = config.defaultLlmConnection;
    const anthropicConn = config.llmConnections.find(c =>
      c.slug === defaultSlug && c.providerType === 'anthropic'
    ) || config.llmConnections.find(c =>
      c.providerType === 'anthropic'
    );
    if (anthropicConn) {
      anthropicConn.defaultModel = configAny.modelDefaults.anthropic;
      changed = true;
    }
  }

  // Apply openai model default to the default openai connection
  // Cast providerType to string for legacy values removed from LlmProviderType
  if (configAny.modelDefaults.openai) {
    const openaiConn = config.llmConnections.find(c =>
      (c.providerType as string) === 'openai' || (c.providerType as string) === 'openai_compat'
    );
    if (openaiConn) {
      openaiConn.defaultModel = configAny.modelDefaults.openai;
      changed = true;
    }
  }

  // Delete modelDefaults
  delete configAny.modelDefaults;
  changed = true;

  return changed;
}

/**
 * Migrate legacy auth config to LLM connections.
 * Call this on app startup before any getLlmConnections() calls.
 *
 * This is a one-time migration that converts:
 * - Legacy authType field → LlmConnection in llmConnections array
 * - Legacy anthropicBaseUrl → LlmConnection.baseUrl
 * - Legacy customModel → LlmConnection.defaultModel
 * - Legacy model → modelDefaults (per provider)
 *
 * After migration, the legacy fields are deleted since they are no longer used.
 */
export function migrateLegacyLlmConnectionsConfig(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalizeModelList = (models?: Array<{ id: string } | string>): string[] => {
    if (!models) return [];
    return models
      .map(model => (typeof model === 'string' ? model : model.id))
      .filter(Boolean);
  };

  const applyCompatDefaults = (target: StoredConfig): boolean => {
    if (!target.llmConnections) return false;
    let changed = false;
    for (const connection of target.llmConnections) {
      // Cast to string for legacy 'openai_compat' values that may still exist on disk
      const providerStr = connection.providerType as string;
      if (providerStr !== 'openai_compat') {
        continue;
      }
      const compatDefaults = getDefaultModelsForConnection(connection.providerType).map(
        m => typeof m === 'string' ? m : m.id
      );
      const normalizedModels = normalizeModelList(connection.models);
      if (normalizedModels.length === 0) {
        connection.models = [...compatDefaults];
        changed = true;
      } else if (normalizedModels.length !== (connection.models?.length ?? 0)) {
        connection.models = [...normalizedModels];
        changed = true;
      }
      // Backfill any new default models that are missing from existing connections
      // (e.g., Sonnet added to compat defaults after user already created connection)
      let currentModels = normalizeModelList(connection.models);
      for (const defaultModel of compatDefaults) {
        if (!currentModels.includes(defaultModel)) {
          currentModels = [...currentModels, defaultModel];
          changed = true;
        }
      }
      if (changed) {
        connection.models = currentModels;
      }
      const currentDefault = connection.defaultModel?.trim();
      if (!currentDefault) {
        connection.defaultModel = (normalizeModelList(connection.models)[0] ?? compatDefaults[0]);
        changed = true;
      } else if (!normalizeModelList(connection.models).includes(currentDefault)) {
        connection.models = [currentDefault, ...normalizeModelList(connection.models).filter(m => m !== currentDefault)];
        changed = true;
      }
    }
    return changed;
  };

  // Already migrated - llmConnections array exists
  if (config.llmConnections !== undefined) {
    // Clean up any remaining legacy fields from previous runs
    let needsSave = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configAny = config as any;
    if ('authType' in config) {
      delete configAny.authType;
      needsSave = true;
    }
    if ('anthropicBaseUrl' in config) {
      delete configAny.anthropicBaseUrl;
      needsSave = true;
    }
    if ('customModel' in config) {
      delete configAny.customModel;
      needsSave = true;
    }
    if ('model' in config) {
      const legacyModel = configAny.model as string | undefined;
      if (legacyModel) {
        const provider = getModelProvider(legacyModel) ?? 'anthropic';
        configAny.modelDefaults = { ...(configAny.modelDefaults ?? {}), [provider]: legacyModel };
      }
      delete configAny.model;
      needsSave = true;
    }
    // Note: applyCompatDefaults() is NOT called here for already-migrated configs.
    // Compat connections are user-owned after creation — the app should not
    // silently extend or override the user's model list on every startup.
    // Compat defaults are only applied during fresh connection creation or
    // first-time legacy migration (the config.llmConnections === undefined path below).

    // Phase 1a-bis: Migrate Codex/Copilot connections to Pi backend
    if (migrateCodexCopilotToPi(config)) {
      needsSave = true;
    }

    // Phase 1b: Normalize legacy Opus IDs/defaults before Pi model-list filtering.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1c: Backfill models/defaultModel on ALL connections (not just compat)
    // This ensures built-in connections (anthropic, openai) always have models populated
    if (backfillAllConnectionModels(config)) {
      needsSave = true;
    }
    // Phase 1d: Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults
    if (migrateModelDefaultsToConnections(config)) {
      needsSave = true;
    }
    // Phase 1e: Normalize anything introduced by modelDefaults.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1f: Migrate legacy/previous Opus workspace defaults → current default Opus
    migrateWorkspaceLegacyOpusToDefaultOpus(config);
    // Phase 1g: Migrate Sonnet 4.5 → Sonnet 4.6 for direct Anthropic connections
    if (migrateSonnet45ToSonnet46(config)) {
      needsSave = true;
    }
    // Phase 1h: Migrate Sonnet 4.5 → Sonnet 4.6 in workspace default models
    migrateWorkspaceSonnet45ToSonnet46(config);
    // Phase 1j: Migrate legacy provider types (bedrock/vertex/anthropic_compat → pi/pi_compat)
    if (migrateLegacyProviderTypes(config)) {
      needsSave = true;
    }
    // Phase 1k: Normalize legacy Opus IDs introduced by provider-type migration.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1l: Rename legacy `hermes-local` connection slug to `hermes`
    if (migrateHermesLocalSlug(config)) {
      needsSave = true;
    }

    if (needsSave) {
      saveConfig(config);
    }
    return;
  }

  // Initialize empty array
  config.llmConnections = [];

  // Legacy migration: if user had authType set, create a connection for them
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  const legacyAuthType = configAny.authType as AuthType | undefined;
  const legacyBaseUrl = configAny.anthropicBaseUrl as string | undefined;
  const legacyCustomModel = configAny.customModel as string | undefined;
  const legacyModel = configAny.model as string | undefined;

  if (legacyAuthType) {
    let migrated: LlmConnection | null = null;

    if (legacyAuthType === 'oauth_token') {
      // Claude Max OAuth
      migrated = {
        slug: 'claude-max',
        name: 'Claude Max',
        providerType: 'anthropic',
        authType: 'oauth',
        models: getDefaultModelsForConnection('anthropic'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_oauth') {
      // ChatGPT Plus OAuth → Pi backend
      migrated = {
        slug: 'codex',
        name: 'ChatGPT Plus (via Pi)',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'openai-codex',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai-codex'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_api_key') {
      // OpenAI API Key → Pi backend
      migrated = {
        slug: 'codex-api',
        name: 'OpenAI API (via Pi)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'api_key') {
      // Anthropic API Key - check if custom endpoint (compat mode → pi_compat)
      const hasCustomEndpoint = !!legacyBaseUrl;
      if (hasCustomEndpoint) {
        migrated = {
          slug: 'anthropic-api',
          name: 'Custom Anthropic-Compatible',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          customEndpoint: { api: 'anthropic-messages' },
          models: getDefaultModelsForConnection('pi_compat'),
          createdAt: Date.now(),
        };
      } else {
        migrated = {
          slug: 'anthropic-api',
          name: 'Anthropic (API Key)',
          providerType: 'anthropic',
          authType: 'api_key',
          models: getDefaultModelsForConnection('anthropic'),
          createdAt: Date.now(),
        };
      }
    }

    if (migrated) {
      // Validate the migrated connection has a valid provider/auth combination
      if (!isValidProviderAuthCombination(migrated.providerType, migrated.authType)) {
        console.warn(
          `[config] Legacy migration created invalid provider/auth combination: ` +
          `providerType=${migrated.providerType}, authType=${migrated.authType} ` +
          `(slug: ${migrated.slug}). Skipping migration for this connection.`
        );
      } else {
        // Apply legacy baseUrl if set
        if (legacyBaseUrl) {
          migrated.baseUrl = legacyBaseUrl;
        }

        // Apply legacy customModel if set
        if (legacyCustomModel) {
          migrated.defaultModel = legacyCustomModel;
        }

        config.llmConnections.push(migrated);
        config.defaultLlmConnection = migrated.slug;
      }
    }
  }

  // Delete legacy fields after migration
  delete configAny.authType;
  delete configAny.anthropicBaseUrl;
  delete configAny.customModel;
  delete configAny.model;

  if (legacyModel) {
    const provider = getModelProvider(legacyModel) ?? 'anthropic';
    configAny.modelDefaults = { ...(configAny.modelDefaults ?? {}), [provider]: legacyModel };
  }

  // Run the same backfill and migration on newly created connections
  migrateCodexCopilotToPi(config);
  backfillAllConnectionModels(config);
  migrateModelDefaultsToConnections(config);
  migrateLegacyOpusToDefaultOpus(config);
  migrateWorkspaceLegacyOpusToDefaultOpus(config);

  saveConfig(config);
}

/**
 * Fix defaultLlmConnection references that point to non-existent connections.
 * This can happen when a connection is removed or was never created
 * (e.g. "anthropic-api" is set as default but only "claude-max" exists).
 *
 * Fixes both the global defaultLlmConnection and per-workspace defaults.
 * Called on app startup alongside other migrations.
 */
export function migrateOrphanedDefaultConnections(): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (!config.llmConnections || config.llmConnections.length === 0) return;

  let changed = false;

  // Fix global default if it points to a non-existent connection
  if (ensureDefaultLlmConnection(config)) {
    changed = true;
  }

  // Fix workspace defaults that point to non-existent connections
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection) {
        const exists = config.llmConnections.some(
          c => c.slug === wsConfig.defaults!.defaultLlmConnection
        );
        if (!exists) {
          delete wsConfig.defaults.defaultLlmConnection;
          saveWorkspaceConfig(ws.rootPath, wsConfig);
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace default connection references:', error);
  }

  if (changed) {
    saveConfig(config);
  }
}

/**
 * Ensure default LLM connection is set correctly.
 * Called internally by write operations to fix inconsistent state.
 * This is NOT called on read - reads never modify config.
 */
export function ensureDefaultLlmConnection(config: StoredConfig): boolean {
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const defaultExists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
  if (!config.defaultLlmConnection || !defaultExists) {
    config.defaultLlmConnection = config.llmConnections[0]!.slug;
    return true;
  }

  return false;
}

/**
 * Migrate legacy global credentials to LLM connection-scoped credentials.
 * This ensures that credentials saved before the LLM connections system
 * are available through the new connection-based auth.
 *
 * Called on app startup (async operation, credentials use encrypted storage).
 *
 * Migration mapping:
 * - claude_oauth::global → llm_oauth::claude-max
 * - anthropic_api_key::global → llm_api_key::anthropic-api
 *
 * After successful migration, legacy credentials are deleted to prevent
 * stale data and reduce credential store clutter.
 */
export async function migrateLegacyCredentials(): Promise<void> {
  const manager = getCredentialManager();
  const debug = (await import('../utils/debug.ts')).debug;

  // Migrate Claude OAuth: claude_oauth::global → llm_oauth::claude-max
  const legacyClaudeOAuth = await manager.getClaudeOAuthCredentials();
  if (legacyClaudeOAuth?.accessToken) {
    // Only migrate if llm_oauth::claude-max doesn't exist yet
    const existingLlmOAuth = await manager.getLlmOAuth('claude-max');
    if (!existingLlmOAuth) {
      await manager.setLlmOAuth('claude-max', {
        accessToken: legacyClaudeOAuth.accessToken,
        refreshToken: legacyClaudeOAuth.refreshToken,
        expiresAt: legacyClaudeOAuth.expiresAt,
      });
      debug('[storage] Migrated legacy Claude OAuth to llm_oauth::claude-max');

      // Delete legacy credential after successful migration
      // Global credentials use just the type - the key format is {type}::global
      try {
        await manager.delete({ type: 'claude_oauth' });
        debug('[storage] Deleted legacy claude_oauth::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy claude_oauth::global:', error);
      }
    }
  }

  // Migrate Anthropic API key: anthropic_api_key::global → llm_api_key::anthropic-api
  const legacyApiKey = await manager.getApiKey();
  if (legacyApiKey) {
    // Only migrate if llm_api_key::anthropic-api doesn't exist yet
    const existingLlmApiKey = await manager.getLlmApiKey('anthropic-api');
    if (!existingLlmApiKey) {
      await manager.setLlmApiKey('anthropic-api', legacyApiKey);
      debug('[storage] Migrated legacy Anthropic API key to llm_api_key::anthropic-api');

      // Delete legacy credential after successful migration
      // Global credentials use just the type - the key format is {type}::global
      try {
        await manager.delete({ type: 'anthropic_api_key' });
        debug('[storage] Deleted legacy anthropic_api_key::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy anthropic_api_key::global:', error);
      }
    }
  }
}
