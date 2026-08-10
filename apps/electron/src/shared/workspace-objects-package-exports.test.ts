import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const RENDERER_WORKSPACE_OBJECT_SUBPATHS = [
  ['@craft-agent/shared/workspace-objects/query', './workspace-objects/query', './src/workspace-objects/query.ts'],
  ['@craft-agent/shared/workspace-objects/service', './workspace-objects/service', './src/workspace-objects/service.ts'],
  ['@craft-agent/shared/workspace-objects/types', './workspace-objects/types', './src/workspace-objects/types.ts'],
  ['@craft-agent/shared/workspace-objects/view-schema', './workspace-objects/view-schema', './src/workspace-objects/view-schema.ts'],
] as const

describe('@craft-agent/shared workspace-object package exports from Electron', () => {
  const sharedPackage = JSON.parse(
    readFileSync(new URL('../../../../packages/shared/package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, string> }

  for (const [specifier, exportKey, source] of RENDERER_WORKSPACE_OBJECT_SUBPATHS) {
    test(`resolves and imports ${specifier}`, async () => {
      expect(sharedPackage.exports[exportKey]).toBe(source)
      expect(import.meta.resolve(specifier)).toEndWith(source.slice(1))
      expect(await import(specifier)).toBeObject()
    })
  }
})
