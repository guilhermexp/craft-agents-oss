import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const rule = require('../no-floating-z-tokens-in-island.cjs')

// The rule keys off the linted file path, and flat config only resolves a
// config for files under the base path — so the fixture paths are anchored to
// the repo root rather than a synthetic `/repo` prefix.
const REPO_ROOT = resolve(import.meta.dir, '../../../..')

// ESLint 10 dropped the eslintrc Linter mode and `linter.defineRule`, so the
// rule is registered as an inline flat-config plugin instead.
function runRule(code: string, relativeFilename: string) {
  const linter = new Linter()

  return linter.verify(
    code,
    [
      {
        files: ['**/*.{js,jsx,ts,tsx}'],
        plugins: {
          'craft-styles': { rules: { 'no-floating-z-tokens-in-island': rule } },
        },
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          'craft-styles/no-floating-z-tokens-in-island': 'error',
        },
      },
    ],
    resolve(REPO_ROOT, relativeFilename),
  )
}

describe('no-floating-z-tokens-in-island (ui)', () => {
  it('flags floating menu token in AnnotationIslandMenu', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      'packages/ui/src/components/annotations/AnnotationIslandMenu.tsx',
    )

    expect(messages.length).toBe(1)
    expect(messages[0]?.message).toContain('Use island z-index tokens')
  })

  it('flags floating backdrop token in island contexts', () => {
    const messages = runRule(
      "const overlayZIndex = 'var(--z-floating-backdrop, 390)'",
      'packages/ui/src/components/ui/Island.tsx',
    )

    expect(messages.length).toBe(1)
  })

  it('allows island tokens in island contexts', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-island, 400)'; const overlay = 'var(--z-island-overlay, 390)'",
      'packages/ui/src/components/overlay/AnnotatableMarkdownDocument.tsx',
    )

    expect(messages.length).toBe(0)
  })

  it('flags floating menu token in IslandFollowUpContentView', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      'packages/ui/src/components/ui/IslandFollowUpContentView.tsx',
    )

    expect(messages.length).toBe(1)
  })

  it('does not apply to non-island files', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      'packages/ui/src/components/markdown/TableExportDropdown.tsx',
    )

    expect(messages.length).toBe(0)
  })
})
