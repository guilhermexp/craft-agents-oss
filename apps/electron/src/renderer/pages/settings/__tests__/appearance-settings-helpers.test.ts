import { describe, expect, it } from 'bun:test'
import { shouldShowHazeScenicBackgroundControls } from '../appearance-settings-helpers'

describe('shouldShowHazeScenicBackgroundControls', () => {
  it('shows scenic background controls for Haze only', () => {
    expect(shouldShowHazeScenicBackgroundControls('haze')).toBe(true)
    expect(shouldShowHazeScenicBackgroundControls('default')).toBe(false)
    expect(shouldShowHazeScenicBackgroundControls('dracula')).toBe(false)
  })
})
