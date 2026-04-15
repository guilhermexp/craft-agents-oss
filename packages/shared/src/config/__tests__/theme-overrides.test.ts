import { describe, expect, it } from 'bun:test'
import { mergeThemeOverrides } from '../theme'

describe('mergeThemeOverrides', () => {
  it('preserves preset values while applying app-level scenic overrides', () => {
    const merged = mergeThemeOverrides(
      {
        mode: 'scenic',
        backgroundImage: 'https://example.com/original.jpg',
        accent: '#a78bfa',
        dark: {
          background: '#111111',
          foreground: '#ffffff',
        },
      },
      {
        backgroundImage: '/Users/test/background.png',
        dark: {
          foreground: '#eeeeee',
        },
      },
    )

    expect(merged.mode).toBe('scenic')
    expect(merged.backgroundImage).toBe('/Users/test/background.png')
    expect(merged.scenicBackgroundOpacity).toBeUndefined()
    expect(merged.accent).toBe('#a78bfa')
    expect(merged.dark).toEqual({
      background: '#111111',
      foreground: '#eeeeee',
    })
  })

  it('overrides scenic background opacity without dropping preset fields', () => {
    const merged = mergeThemeOverrides(
      {
        mode: 'scenic',
        backgroundImage: 'https://example.com/original.jpg',
        scenicBackgroundOpacity: 1,
        accent: '#a78bfa',
      },
      {
        scenicBackgroundOpacity: 0.45,
      },
    )

    expect(merged.mode).toBe('scenic')
    expect(merged.backgroundImage).toBe('https://example.com/original.jpg')
    expect(merged.scenicBackgroundOpacity).toBe(0.45)
    expect(merged.accent).toBe('#a78bfa')
  })

  it('overrides scenic background contrast without dropping preset fields', () => {
    const merged = mergeThemeOverrides(
      {
        mode: 'scenic',
        backgroundImage: 'https://example.com/original.jpg',
        scenicBackgroundContrast: 1,
        accent: '#a78bfa',
      },
      {
        scenicBackgroundContrast: 1.3,
      },
    )

    expect(merged.mode).toBe('scenic')
    expect(merged.backgroundImage).toBe('https://example.com/original.jpg')
    expect(merged.scenicBackgroundContrast).toBe(1.3)
    expect(merged.accent).toBe('#a78bfa')
  })

  it('overrides scenic background blur without dropping preset fields', () => {
    const merged = mergeThemeOverrides(
      {
        mode: 'scenic',
        backgroundImage: 'https://example.com/original.jpg',
        scenicBackgroundBlur: 0,
        accent: '#a78bfa',
      },
      {
        scenicBackgroundBlur: 12,
      },
    )

    expect(merged.mode).toBe('scenic')
    expect(merged.backgroundImage).toBe('https://example.com/original.jpg')
    expect(merged.scenicBackgroundBlur).toBe(12)
    expect(merged.accent).toBe('#a78bfa')
  })
})
