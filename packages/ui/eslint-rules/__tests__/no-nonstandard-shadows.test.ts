import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rule = require('../no-nonstandard-shadows.cjs')

// ESLint 10 dropped the eslintrc Linter mode and `linter.defineRule`, so the
// rule is registered as an inline flat-config plugin instead.
function runRule(code: string) {
  const linter = new Linter()

  return linter.verify(code, [
    {
      files: ['**/*.{js,jsx,ts,tsx}'],
      plugins: {
        'craft-styles': { rules: { 'no-nonstandard-shadows': rule } },
      },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: {
        'craft-styles/no-nonstandard-shadows': ['error', {
          allowedClasses: ['shadow-none', 'shadow-minimal'],
          allowInlineNone: true,
        }],
      },
    },
  ])
}

describe('no-nonstandard-shadows (ui)', () => {
  it('flags a disallowed shadow utility class', () => {
    const messages = runRule('const cls = "rounded shadow-md"')
    expect(messages.length).toBe(1)
    expect(messages[0]?.message).toContain('Disallowed shadow class "shadow-md"')
  })

  it('allows an approved shadow utility class', () => {
    expect(runRule('const cls = "rounded shadow-minimal"').length).toBe(0)
  })

  it('flags an inline boxShadow value', () => {
    const messages = runRule("const style = { boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }")
    expect(messages.length).toBe(1)
    expect(messages[0]?.message).toContain('Avoid inline boxShadow usage')
  })

  it('flags a direct style.boxShadow assignment', () => {
    expect(runRule("el.style.boxShadow = 'inset 0 0 0 1px red'").length).toBe(1)
  })

  it('allows the none reset in a style object and in a style assignment', () => {
    expect(runRule("const style = { boxShadow: 'none' }").length).toBe(0)
    expect(runRule("el.style.boxShadow = 'none'").length).toBe(0)
  })

  it('allows the empty-string reset, the only way to drop an inline shadow', () => {
    expect(runRule("el.style.boxShadow = ''").length).toBe(0)
    expect(runRule("Object.assign(el.style, { backgroundColor: '', boxShadow: '' })").length).toBe(0)
  })

  it('still flags a shadow that merely contains the word none', () => {
    expect(runRule("el.style.boxShadow = '0 0 0 1px none-ish'").length).toBe(1)
  })
})
