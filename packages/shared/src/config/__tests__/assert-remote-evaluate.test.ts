/**
 * SECURITY (auditoria 2026-07-14) — F1.2.
 * `assertRemoteEvaluateAllowed` é a fonte única do gate de `browser_tool
 * evaluate`. O path local (SessionManager) passou a chamá-lo, fechando o
 * bypass que existia só no path remoto (dispatcher). Aqui exercitamos o gate
 * real contra o read de config real (com o loader stubado para não tocar disco).
 */
import { describe, expect, it, mock } from 'bun:test'

let storedConfig: { allowRemoteEvaluate?: boolean } | null = { allowRemoteEvaluate: true }

mock.module('../storage.ts', () => ({
  loadStoredConfig: () => storedConfig,
  saveConfig: () => {},
  loadConfigDefaults: () => ({ defaults: { allowRemoteEvaluate: true } }),
}))

const { assertRemoteEvaluateAllowed } = await import('../preference-storage.ts')

describe('assertRemoteEvaluateAllowed (evaluate gate)', () => {
  it('rejects when allowRemoteEvaluate=false (attack path)', () => {
    storedConfig = { allowRemoteEvaluate: false }
    expect(() => assertRemoteEvaluateAllowed()).toThrow(/browser_evaluate disabled by config/)
  })

  it('allows when allowRemoteEvaluate=true', () => {
    storedConfig = { allowRemoteEvaluate: true }
    expect(() => assertRemoteEvaluateAllowed()).not.toThrow()
  })

  it('falls back to secure default handling when unset (default true)', () => {
    storedConfig = {}
    expect(() => assertRemoteEvaluateAllowed()).not.toThrow()
  })
})
