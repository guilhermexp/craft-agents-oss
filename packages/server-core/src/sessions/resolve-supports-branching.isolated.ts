/**
 * resolveSupportsBranching — fallback por provider quando o agent é lazy (F2.2).
 *
 * Regressão: o fallback era `return true` cego, então uma sessão Hermes
 * restaurada (agent null após restart) reportava supportsBranching=true e a
 * UI oferecia branch com amnésia silenciosa (Hermes não consome branchFrom*).
 *
 * Isolated: CONFIG_DIR é resolvido no load do módulo de config, então o
 * CRAFT_CONFIG_DIR precisa apontar pro fixture antes de qualquer import.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'craft-branching-'))
process.env.CRAFT_CONFIG_DIR = configDir
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  workspaces: [],
  defaultLlmConnection: 'claude-api',
  llmConnections: [
    { slug: 'claude-api', name: 'Claude', providerType: 'anthropic', authType: 'api_key' },
    { slug: 'hermes-local', name: 'Hermes', providerType: 'hermes', authType: 'none' },
    { slug: 'pi-openai', name: 'OpenAI', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key' },
  ],
}))

const { createManagedSession, resolveSupportsBranching } = await import('./SessionManager.ts')

const workspace = {
  id: 'ws_branching',
  name: 'Branching Test',
  rootPath: join(configDir, 'ws'),
  createdAt: Date.now(),
} as any

describe('resolveSupportsBranching (lazy agent fallback)', () => {
  it('restored Hermes session (agent null) reports supportsBranching=false', () => {
    const managed = createManagedSession({ id: 's_hermes', llmConnection: 'hermes-local' }, workspace)
    expect(managed.agent).toBeNull()
    expect(resolveSupportsBranching(managed)).toBe(false)
  })

  it('restored Claude session keeps supportsBranching=true', () => {
    const managed = createManagedSession({ id: 's_claude', llmConnection: 'claude-api' }, workspace)
    expect(resolveSupportsBranching(managed)).toBe(true)
  })

  it('restored Pi session keeps supportsBranching=true', () => {
    const managed = createManagedSession({ id: 's_pi', llmConnection: 'pi-openai' }, workspace)
    expect(resolveSupportsBranching(managed)).toBe(true)
  })

  it('session without explicit connection resolves via default connection', () => {
    const managed = createManagedSession({ id: 's_default' }, workspace)
    expect(resolveSupportsBranching(managed)).toBe(true)
  })

  it('live agent instance stays authoritative over the connection fallback', () => {
    const managed = createManagedSession({ id: 's_live', llmConnection: 'hermes-local' }, workspace)
    managed.agent = { supportsBranching: false } as any
    expect(resolveSupportsBranching(managed)).toBe(false)
  })
})
