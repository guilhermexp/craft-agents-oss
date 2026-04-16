import { describe, expect, it } from 'bun:test'
import { resolveTheme } from '@config/theme'
import { isScenicTheme } from '../theme-mode'

describe('isScenicTheme', () => {
  it('returns true for scenic themes with a background image', () => {
    const theme = resolveTheme({
      mode: 'scenic',
      backgroundImage: '/themes/haze/background.png',
    })

    expect(isScenicTheme(theme)).toBe(true)
  })

  it('returns false for solid themes even when an override adds backgroundImage', () => {
    const theme = resolveTheme({
      mode: 'solid',
      backgroundImage: '/tmp/custom-background.png',
    })

    expect(isScenicTheme(theme)).toBe(false)
  })
})
