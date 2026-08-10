import { describe, expect, it } from 'bun:test'
import { getProviderIconThemeClassName } from '../provider-icons'

// The inversion marker is `theme-aware-invert` (index.css, keyed off the
// runtime `html[data-theme-brightness="dark"]` attribute), NOT Tailwind's
// `dark:` variant — `dark:` only fires for the user-selected mode and left
// these black-on-transparent marks unreadable under scenic / dark-only
// presets. See 802a99ae.
describe('getProviderIconThemeClassName', () => {
  it('marks OpenAI icons for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('openai')).toBe('theme-aware-invert')
  })

  it('marks OpenAI-compatible URLs for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('openai_compat', 'https://api.openai.com/v1')).toBe('theme-aware-invert')
  })

  it('marks Pi OpenAI Codex auth icons for dark-theme inversion', () => {
    expect(getProviderIconThemeClassName('pi', undefined, 'openai-codex')).toBe('theme-aware-invert')
  })

  it('does not invert providers with theme-safe icons', () => {
    expect(getProviderIconThemeClassName('anthropic')).toBe('')
  })
})
