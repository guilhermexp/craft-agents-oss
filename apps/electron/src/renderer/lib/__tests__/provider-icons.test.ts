import { describe, expect, it } from 'bun:test'
import { getProviderIconThemeClassName } from '../provider-icons'

describe('getProviderIconThemeClassName', () => {
  it('marks OpenAI icons for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('openai')).toBe('dark:invert')
  })

  it('marks OpenAI-compatible URLs for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('openai_compat', 'https://api.openai.com/v1')).toBe('dark:invert')
  })

  it('marks Pi OpenAI Codex auth icons for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('pi', undefined, 'openai-codex')).toBe('dark:invert')
  })

  it('does not invert providers with theme-safe icons', () => {
    expect(getProviderIconThemeClassName('anthropic')).toBe('')
  })
})
