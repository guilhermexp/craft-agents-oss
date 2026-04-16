import { describe, expect, it } from 'bun:test'
import { getContentFrameCardClassName } from './content-frame-styles'

describe('getContentFrameCardClassName', () => {
  it('marks preview/data-table cards as scenic-opaque', () => {
    expect(getContentFrameCardClassName()).toContain('overlay-solid-surface')
  })
})
