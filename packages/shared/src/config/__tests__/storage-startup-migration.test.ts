import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import '../../../tests/setup/register-pi-model-resolver.ts'
import { getAllPiModels, getPiModelsForAuthProvider } from '../models-pi.ts'
import { getModelDisplayName, type ModelDefinition } from '../models.ts'
import { registerPiModelResolver } from '../llm-connections.ts'
import {
  runConfigMigrations,
  ConfigMigrationError,
  LLM_CONNECTION_MIGRATIONS,
  type ConfigMigration,
} from '../llm-connection-migrations.ts'
import { loadWorkspaceConfig } from '../../workspaces/storage.ts'
import type { StoredConfig } from '../storage.ts'
import type { LlmConnection, LlmAuthType, ModelSelectionMode } from '../llm-connections.ts'
import type { Workspace } from '@craft-agent/core/types'

/** Opus generations the migration may land on, newest first. */
const OPUS_PREFERENCE = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'] as const

/**
 * The migration keeps a connection on the newest Opus its provider catalog
 * actually serves. The Pi SDK catalog lags the Anthropic API, so resolve the
 * expectation from the live catalog instead of hardcoding a generation.
 */
function pickPiOpusDefault(authProvider: string, toId: (bare: string) => string): string {
  const available = new Set(getPiModelsForAuthProvider(authProvider).map(m => m.id))
  const last = toId(OPUS_PREFERENCE[OPUS_PREFERENCE.length - 1]!)
  return OPUS_PREFERENCE.map(toId).find(id => available.has(id)) ?? last
}

const PI_ANTHROPIC_OPUS_DEFAULT = pickPiOpusDefault('anthropic', bare => `pi/${bare}`)
const PI_ANTHROPIC_OPUS_DEFAULT_NAME = getModelDisplayName(PI_ANTHROPIC_OPUS_DEFAULT.slice(3))
const PI_BEDROCK_OPUS_DEFAULT = pickPiOpusDefault('amazon-bedrock', bare => `pi/us.anthropic.${bare}`)
const PI_BEDROCK_OPUS_DEFAULT_NAME = getModelDisplayName(PI_BEDROCK_OPUS_DEFAULT.slice(3))

afterEach(() => {
  registerPiModelResolver((piAuthProvider?: string) =>
    piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels(),
  )
})

// ============================================================
// In-memory fixtures — the runner is pure over StoredConfig, so no config dir,
// no subprocess, no disk diffing for the common (connection-only) case.
// ============================================================

type FixtureModel = { id: string; name?: string; [key: string]: unknown }

type ConnectionFixture = {
  slug: string
  name: string
  providerType: string
  authType: LlmAuthType
  piAuthProvider?: string
  modelSelectionMode?: ModelSelectionMode
  createdAt?: number
  models?: Array<FixtureModel | string>
  defaultModel?: string
  customEndpoint?: { api: string }
}

/**
 * Build a StoredConfig fixture. Connections model config.json as it may appear
 * on disk — including legacy provider values (e.g. 'bedrock') the current
 * LlmConnection type no longer expresses but the migrations must still handle.
 */
function makeConfig(connections: ConnectionFixture[], workspaces: Workspace[] = []): StoredConfig {
  return {
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    activeSessionId: null,
    defaultLlmConnection: connections[0]?.slug,
    // Legacy on-disk shapes are broader than the current LlmConnection type.
    llmConnections: connections as unknown as LlmConnection[],
  }
}

/** Run the versioned migration list over a fixture, returning the mutated config. */
function migrate(config: StoredConfig): StoredConfig {
  return runConfigMigrations(config, LLM_CONNECTION_MIGRATIONS).config
}

function findConnection(config: StoredConfig, slug: string): LlmConnection | undefined {
  return config.llmConnections?.find(c => c.slug === slug)
}

function modelEntriesOf(connection: LlmConnection | undefined): Array<ModelDefinition | string> {
  return connection?.models ?? []
}

function modelIdsOf(connection: LlmConnection | undefined): string[] {
  return modelEntriesOf(connection).map(m => (typeof m === 'string' ? m : m.id))
}

function modelNameOf(connection: LlmConnection | undefined, id: string): string | undefined {
  const entry = modelEntriesOf(connection).find(m => (typeof m === 'string' ? m : m.id) === id)
  return entry && typeof entry !== 'string' ? entry.name : undefined
}

/** Create a real temp workspace with a default model so the workspace phases can rewrite it. */
function makeWorkspace(defaultModel: string): Workspace {
  const rootPath = mkdtempSync(join(tmpdir(), 'craft-agent-ws-'))
  const wsConfig = {
    id: 'ws-config-1',
    name: 'My Workspace',
    slug: 'my-workspace',
    defaults: { model: defaultModel },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify(wsConfig, null, 2), 'utf-8')
  return { id: 'ws-1', name: 'My Workspace', slug: 'my-workspace', rootPath, createdAt: Date.now() }
}

function readWorkspaceModel(workspace: Workspace): string | undefined {
  return loadWorkspaceConfig(workspace.rootPath)?.defaults?.model
}

describe('startup migration (connections)', () => {
  it('repairs broken pi-api-key openai-codex provider', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (OpenAI)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai-codex',
        createdAt: Date.now(),
        models: [],
        defaultModel: '',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.piAuthProvider).toBe('openai')
    expect(connection!.authType).toBe('api_key')
  })

  it('preserves userDefined3Tier model subsets', () => {
    const userDefinedModels = ['pi/claude-opus-4-6', 'pi/claude-sonnet-4-6', 'pi/claude-haiku-4-5']
    const migratedModels = [PI_ANTHROPIC_OPUS_DEFAULT, 'pi/claude-sonnet-4-6', 'pi/claude-haiku-4-5']

    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: userDefinedModels,
        defaultModel: userDefinedModels[0],
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.modelSelectionMode).toBe('userDefined3Tier')
    expect(modelIdsOf(connection)).toEqual(migratedModels)
    expect(connection!.defaultModel).toBe(migratedModels[0])
  })

  it('normalizes auto mode model set back to provider defaults', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        createdAt: Date.now(),
        models: ['pi/claude-haiku-4-5'],
        defaultModel: 'pi/claude-haiku-4-5',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.modelSelectionMode).toBe('automaticallySyncedFromProvider')
    const modelIds = modelIdsOf(connection)
    expect(modelIds.length).toBeGreaterThan(1)
    expect(modelIds).toContain(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIds).toContain(connection!.defaultModel!)
  })

  it('repairs userDefined3Tier lists by removing invalid IDs and fixing default model', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/claude-opus-4-6', 'pi/not-real', 'pi/claude-haiku-4-5'],
        defaultModel: 'pi/not-real',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.modelSelectionMode).toBe('userDefined3Tier')
    expect(modelIdsOf(connection)).toEqual([PI_ANTHROPIC_OPUS_DEFAULT, 'pi/claude-haiku-4-5'])
    expect(connection!.defaultModel).toBe(PI_ANTHROPIC_OPUS_DEFAULT)
  })

  it('falls back to provider defaults when userDefined3Tier becomes empty after filtering', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/not-real-1', 'pi/not-real-2'],
        defaultModel: 'pi/not-real-1',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.modelSelectionMode).toBe('userDefined3Tier')
    const modelIds = modelIdsOf(connection)
    expect(modelIds.length).toBeGreaterThan(1)
    expect(modelIds).toContain(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIds).not.toContain('pi/not-real-1')
    expect(connection!.defaultModel).toBe(modelIds[0])
  })

  it('normalizes legacy unprefixed userDefined3Tier model IDs instead of resetting', () => {
    // Derive currently-valid OpenRouter IDs from the live Pi catalog. The migration
    // normalizes (pi/-prefixes) known IDs and drops unknown ones, so hardcoding a
    // specific model here makes the test brittle when models.dev drifts across Pi
    // SDK uplifts (e.g. x-ai/grok-4 aged out by 0.79.x).
    const openrouterIds = getPiModelsForAuthProvider('openrouter').map(m => m.id)
    expect(openrouterIds).toContain('pi/openrouter/auto')
    const otherPrefixed = openrouterIds.find(id => id !== 'pi/openrouter/auto')
    if (!otherPrefixed) throw new Error('expected at least two OpenRouter models in catalog')
    const expectedPrefixed = ['pi/openrouter/auto', otherPrefixed]
    const legacyUnprefixed = expectedPrefixed.map(id => id.slice('pi/'.length))

    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (OpenRouter)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openrouter',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: legacyUnprefixed,
        defaultModel: legacyUnprefixed[0],
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection).toBeDefined()
    expect(connection!.modelSelectionMode).toBe('userDefined3Tier')
    expect(modelIdsOf(connection)).toEqual(expectedPrefixed)
    expect(connection!.defaultModel).toBe(expectedPrefixed[0])
  })
})

describe('legacy Opus migration to default Opus', () => {
  it('falls back to Pi Opus 4.7 when it is the newest catalog entry available', () => {
    registerPiModelResolver(() => [{
      id: 'pi/claude-opus-4-7',
      name: 'Opus 4.7',
      shortName: 'Opus',
      description: 'Test catalog entry',
      provider: 'pi',
      contextWindow: 1_000_000,
    }])
    const opusPhase = LLM_CONNECTION_MIGRATIONS.find(
      migration => migration.id === 'legacy-opus-normalize:pre-filter',
    )!
    const config = runConfigMigrations(makeConfig([{
      slug: 'pi-api-key',
      name: 'Craft Agents Backend (Anthropic)',
      providerType: 'pi',
      authType: 'api_key',
      piAuthProvider: 'anthropic',
      models: ['pi/claude-opus-4-6'],
      defaultModel: 'claude-opus-4-6',
    }]), [opusPhase]).config

    expect(findConnection(config, 'pi-api-key')!.defaultModel).toBe('pi/claude-opus-4-7')
  })

  it('falls back to Bedrock Opus 4.7 when newer native IDs are unavailable', () => {
    registerPiModelResolver(() => [{
      id: 'pi/us.anthropic.claude-opus-4-7',
      name: 'Opus 4.7',
      shortName: 'Opus',
      description: 'Test catalog entry',
      provider: 'pi',
      contextWindow: 1_000_000,
    }])
    const opusPhase = LLM_CONNECTION_MIGRATIONS.find(
      migration => migration.id === 'legacy-opus-normalize:pre-filter',
    )!
    const config = runConfigMigrations(makeConfig([{
      slug: 'pi-bedrock',
      name: 'Craft Agents Backend (Bedrock)',
      providerType: 'pi',
      authType: 'iam_credentials',
      piAuthProvider: 'amazon-bedrock',
      models: ['pi/us.anthropic.claude-opus-4-6-v1'],
      defaultModel: 'claude-opus-4-6',
    }]), [opusPhase]).config

    expect(findConnection(config, 'pi-bedrock')!.defaultModel).toBe('pi/us.anthropic.claude-opus-4-7')
  })

  it('prefers Pi Opus 4.8 over 4.7 when both are available', () => {
    registerPiModelResolver(() => [
      {
        id: 'pi/claude-opus-4-7',
        name: 'Opus 4.7',
        shortName: 'Opus',
        description: 'Test catalog entry',
        provider: 'pi',
        contextWindow: 1_000_000,
      },
      {
        id: 'pi/claude-opus-4-8',
        name: 'Opus 4.8',
        shortName: 'Opus',
        description: 'Test catalog entry',
        provider: 'pi',
        contextWindow: 1_000_000,
      },
    ])
    const opusPhase = LLM_CONNECTION_MIGRATIONS.find(
      migration => migration.id === 'legacy-opus-normalize:pre-filter',
    )!
    const config = runConfigMigrations(makeConfig([{
      slug: 'pi-api-key',
      name: 'Craft Agents Backend (Anthropic)',
      providerType: 'pi',
      authType: 'api_key',
      piAuthProvider: 'anthropic',
      models: ['pi/claude-opus-4-6'],
      defaultModel: 'claude-opus-4-6',
    }]), [opusPhase]).config

    expect(findConnection(config, 'pi-api-key')!.defaultModel).toBe('pi/claude-opus-4-8')
  })

  it('migrates direct Anthropic default/model entries from Opus 4.6 to Opus 5 while keeping Opus 4.7', () => {
    const config = migrate(makeConfig([
      {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
        models: [
          { id: 'claude-opus-4-6', name: 'Opus 4.6', shortName: 'Opus', provider: 'anthropic', contextWindow: 200_000 },
          { id: 'claude-opus-4-7', name: 'Opus 4.7', shortName: 'Opus', provider: 'anthropic', contextWindow: 1_000_000 },
          { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', shortName: 'Sonnet', provider: 'anthropic', contextWindow: 200_000 },
        ],
        defaultModel: 'claude-opus-4-6',
      },
    ]))

    const connection = findConnection(config, 'anthropic')
    const ids = modelIdsOf(connection)
    expect(connection!.defaultModel).toBe('claude-opus-5')
    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).not.toContain('claude-opus-4-6')
    expect(ids.filter(id => id === 'claude-opus-5')).toHaveLength(1)
    expect(modelNameOf(connection, 'claude-opus-5')).toBe('Opus 5')
  })

  it('migrates direct Anthropic Opus 4.5 defaults straight to Opus 5', () => {
    const config = migrate(makeConfig([
      {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
        models: ['claude-opus-4-5-20251101', 'claude-sonnet-4-6'],
        defaultModel: 'claude-opus-4-5-20251101',
      },
    ]))

    const connection = findConnection(config, 'anthropic')
    const ids = modelIdsOf(connection)
    expect(connection!.defaultModel).toBe('claude-opus-5')
    expect(ids).toContain('claude-opus-5')
    expect(ids).not.toContain('claude-opus-4-5-20251101')
  })

  it('migrates previous direct Anthropic Opus 4.8 defaults to Opus 5 while keeping 4.8 selectable', () => {
    const config = migrate(makeConfig([
      {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
        models: ['claude-opus-4-8', 'claude-sonnet-4-6'],
        defaultModel: 'claude-opus-4-8',
      },
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/claude-opus-4-8', 'pi/claude-sonnet-4-6'],
        defaultModel: 'pi/claude-opus-4-8',
      },
    ]))

    const anthropic = findConnection(config, 'anthropic')
    expect(anthropic!.defaultModel).toBe('claude-opus-5')
    expect(modelIdsOf(anthropic)).toEqual(['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6'])

    // Pi lags the Anthropic API catalog, so it stays on the newest Opus it serves.
    const pi = findConnection(config, 'pi-api-key')
    expect(pi!.defaultModel).toBe(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIdsOf(pi)).toEqual([PI_ANTHROPIC_OPUS_DEFAULT, 'pi/claude-sonnet-4-6'])
  })

  it('leaves an explicitly selected Opus 4.7 default alone', () => {
    const config = migrate(makeConfig([
      {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
        models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
        defaultModel: 'claude-opus-4-7',
      },
    ]))

    const connection = findConnection(config, 'anthropic')
    expect(connection!.defaultModel).toBe('claude-opus-4-7')
    expect(modelIdsOf(connection)).toContain('claude-opus-4-7')
  })

  it('migrates workspace default Opus 4.6 to Opus 5', () => {
    const workspace = makeWorkspace('claude-opus-4-6')
    migrate(makeConfig(
      [
        {
          slug: 'anthropic',
          name: 'Anthropic',
          providerType: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          models: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
          defaultModel: 'claude-opus-5',
        },
      ],
      [workspace],
    ))

    expect(readWorkspaceModel(workspace)).toBe('claude-opus-5')
  })

  it('migrates workspace default Opus 4.8 to Opus 5', () => {
    const workspace = makeWorkspace('claude-opus-4-8')
    migrate(makeConfig(
      [
        {
          slug: 'anthropic',
          name: 'Anthropic',
          providerType: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          models: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
          defaultModel: 'claude-opus-5',
        },
      ],
      [workspace],
    ))

    expect(readWorkspaceModel(workspace)).toBe('claude-opus-5')
  })

  it('migrates Pi Anthropic Opus 4.6 IDs to the best available Opus default', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: [
          { id: 'pi/claude-opus-4-6', name: 'Opus 4.6', shortName: 'Opus', provider: 'pi', contextWindow: 200_000 },
          'pi/claude-sonnet-4-6',
        ],
        defaultModel: 'pi/claude-opus-4-6',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection!.defaultModel).toBe(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIdsOf(connection)).toEqual([PI_ANTHROPIC_OPUS_DEFAULT, 'pi/claude-sonnet-4-6'])
    expect(modelNameOf(connection, PI_ANTHROPIC_OPUS_DEFAULT)).toBe(PI_ANTHROPIC_OPUS_DEFAULT_NAME)
  })

  it('migrates Pi Bedrock Opus 4.6 IDs to the best available Opus native IDs', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Bedrock)',
        providerType: 'pi',
        authType: 'iam_credentials',
        piAuthProvider: 'amazon-bedrock',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: [
          { id: 'pi/us.anthropic.claude-opus-4-6-v1', name: 'Opus 4.6', shortName: 'Opus', provider: 'pi', contextWindow: 200_000 },
          'pi/us.anthropic.claude-sonnet-4-6',
        ],
        defaultModel: 'pi/us.anthropic.claude-opus-4-6-v1',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection!.defaultModel).toBe(PI_BEDROCK_OPUS_DEFAULT)
    expect(modelIdsOf(connection)).toEqual([PI_BEDROCK_OPUS_DEFAULT, 'pi/us.anthropic.claude-sonnet-4-6'])
    expect(modelNameOf(connection, PI_BEDROCK_OPUS_DEFAULT)).toBe(PI_BEDROCK_OPUS_DEFAULT_NAME)
  })

  it('migrates legacy unprefixed Pi Anthropic Opus 4.6 IDs to pi-prefixed best available Opus', () => {
    const config = migrate(makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
        defaultModel: 'claude-opus-4-6',
      },
    ]))

    const connection = findConnection(config, 'pi-api-key')
    expect(connection!.defaultModel).toBe(PI_ANTHROPIC_OPUS_DEFAULT)
    expect(modelIdsOf(connection)).toEqual([PI_ANTHROPIC_OPUS_DEFAULT, 'pi/claude-sonnet-4-6'])
  })

  it('migrates legacy Bedrock provider Opus 4.6 IDs to Pi Bedrock best available Opus', () => {
    const config = migrate(makeConfig([
      {
        slug: 'legacy-bedrock',
        name: 'Legacy Bedrock',
        providerType: 'bedrock',
        authType: 'iam_credentials',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
        defaultModel: 'claude-opus-4-6',
      },
    ]))

    const connection = findConnection(config, 'legacy-bedrock')
    expect(connection!.providerType).toBe('pi')
    expect(connection!.piAuthProvider).toBe('amazon-bedrock')
    expect(connection!.defaultModel).toBe(PI_BEDROCK_OPUS_DEFAULT)
    expect(modelIdsOf(connection)).toEqual([PI_BEDROCK_OPUS_DEFAULT, 'pi/us.anthropic.claude-sonnet-4-6'])
  })
})

describe('migration runner contract', () => {
  it('is idempotent: re-running applies nothing and preserves the config', () => {
    const config = makeConfig([
      {
        slug: 'pi-api-key',
        name: 'Craft Agents Backend (Anthropic)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
        createdAt: Date.now(),
        models: ['pi/claude-opus-4-6', 'pi/claude-sonnet-4-6'],
        defaultModel: 'pi/claude-opus-4-6',
      },
    ])

    const first = runConfigMigrations(config, LLM_CONNECTION_MIGRATIONS)
    expect(first.applied.length).toBeGreaterThan(0)
    expect(first.failure).toBeUndefined()

    const before = structuredClone(first.config)
    const second = runConfigMigrations(first.config, LLM_CONNECTION_MIGRATIONS)
    expect(second.applied).toEqual([])
    expect(second.config).toEqual(before)
  })

  it('stops at the first failing phase and names it', () => {
    const ran: string[] = []
    const ok: ConfigMigration = { id: 'ok', apply: () => { ran.push('ok'); return true } }
    const boom: ConfigMigration = { id: 'boom', apply: () => { throw new Error('kaboom') } }
    const never: ConfigMigration = { id: 'never', apply: () => { ran.push('never'); return true } }

    const result = runConfigMigrations(makeConfig([]), [ok, boom, never])

    expect(result.applied).toEqual(['ok'])
    expect(result.failure?.id).toBe('boom')
    expect(result.failure?.error.message).toBe('kaboom')
    expect(ran).toEqual(['ok'])
  })
})

describe('ConfigMigrationError', () => {
  it('wraps a runner failure, naming the phase and preserving the cause', () => {
    const boom: ConfigMigration = { id: 'boom', apply: () => { throw new Error('kaboom') } }
    const result = runConfigMigrations(makeConfig([]), [boom])
    expect(result.failure).toBeDefined()

    // migrateLegacyLlmConnectionsConfig() rethrows runner failures this way.
    const error = new ConfigMigrationError(result.failure!.id, result.failure!.error)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ConfigMigrationError')
    expect(error.migrationId).toBe('boom')
    expect(error.cause).toBe(result.failure!.error)
    expect(error.message).toBe("Config migration 'boom' failed: kaboom")
  })
})

// ============================================================
// End-to-end integration: exercises migrateLegacyLlmConnectionsConfig() over a
// real temp config dir (load -> migrate -> save -> re-read), which the pure
// runner tests above deliberately do not touch: disk gating, JSON round-trip,
// and the fresh-init (llmConnections === undefined) path.
// ============================================================

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const PI_RESOLVER_SETUP_PATH = pathToFileURL(
  join(import.meta.dir, '..', '..', '..', 'tests', 'setup', 'register-pi-model-resolver.ts'),
).href

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  // Make the workspace look valid to loadStoredConfig() so migration can run.
  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({ id: 'ws-config-1', name: 'My Workspace', slug: 'my-workspace', createdAt: Date.now(), updatedAt: Date.now() }, null, 2),
    'utf-8',
  )

  return { configDir, workspaceRoot, configPath: join(configDir, 'config.json') }
}

function writeRootConfig(configPath: string, workspaceRoot: string, extra: Record<string, unknown>) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
        ...extra,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

function runMigration(configDir: string) {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import '${PI_RESOLVER_SETUP_PATH}'; import { migrateLegacyLlmConnectionsConfig } from '${STORAGE_MODULE_PATH}'; migrateLegacyLlmConnectionsConfig();`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(
      `migration subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
    )
  }
}

interface OnDiskConnection {
  slug: string
  providerType?: string
  authType?: string
  piAuthProvider?: string
}

interface OnDiskConfig {
  llmConnections?: OnDiskConnection[]
  defaultLlmConnection?: string
  migrationsApplied?: string[]
}

function readConfigJson(configPath: string): OnDiskConfig {
  // Reading a config file this test just wrote; the shape is known here.
  return JSON.parse(readFileSync(configPath, 'utf-8')) as OnDiskConfig
}

describe('migrateLegacyLlmConnectionsConfig (integration)', () => {
  it('repairs a connection on disk and preserves unrelated legacy fields through the save spread', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, {
      defaultLlmConnection: 'pi-api-key',
      // Legacy field with no reader/writer left; must survive saveConfig()'s spread.
      migrationsApplied: ['legacy-phase'],
      llmConnections: [
        {
          slug: 'pi-api-key',
          name: 'Craft Agents Backend (OpenAI)',
          providerType: 'pi',
          authType: 'api_key',
          // Broken state from an earlier migration: api-key connection tagged codex.
          piAuthProvider: 'openai-codex',
          createdAt: Date.now(),
          models: [],
          defaultModel: '',
        },
      ],
    })

    runMigration(configDir)

    const config = readConfigJson(configPath)
    const connection = (config.llmConnections ?? []).find(c => c.slug === 'pi-api-key')
    expect(connection).toBeDefined()
    // Applied phase was persisted (disk gating: applied.length > 0 -> saveConfig).
    expect(connection!.piAuthProvider).toBe('openai')
    expect(connection!.authType).toBe('api_key')
    // Unrelated legacy top-level field survived the save spread.
    expect(config.migrationsApplied).toEqual(['legacy-phase'])
  })

  it('initializes connections from legacy auth on fresh init (llmConnections === undefined) and writes them', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    // No llmConnections key at all -> fresh-init path via initLlmConnectionsFromLegacy.
    writeRootConfig(configPath, workspaceRoot, {
      authType: 'api_key',
    })

    // Pre-condition: the config on disk has no llmConnections.
    expect('llmConnections' in readConfigJson(configPath)).toBe(false)

    runMigration(configDir)

    const config = readConfigJson(configPath)
    // Fresh init forces a save even though there was nothing to migrate before it.
    expect(Array.isArray(config.llmConnections)).toBe(true)
    const anthropic = (config.llmConnections ?? []).find(c => c.slug === 'anthropic-api')
    expect(anthropic).toBeDefined()
    expect(anthropic!.providerType).toBe('anthropic')
    expect(config.defaultLlmConnection).toBe('anthropic-api')
  })
})
