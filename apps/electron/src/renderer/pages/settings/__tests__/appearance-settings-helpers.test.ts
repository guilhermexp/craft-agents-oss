import { describe, expect, it } from 'bun:test'
import { shouldShowScenicBackgroundControls } from '../appearance-settings-helpers'

describe('shouldShowScenicBackgroundControls', () => {
  it('shows scenic background controls for any scenic-mode theme', () => {
    expect(shouldShowScenicBackgroundControls('scenic')).toBe(true)
    expect(shouldShowScenicBackgroundControls('solid')).toBe(false)
    expect(shouldShowScenicBackgroundControls(undefined)).toBe(false)
  })
})
