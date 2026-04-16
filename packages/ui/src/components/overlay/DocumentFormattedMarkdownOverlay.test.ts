import { describe, expect, it } from 'bun:test'
import { getDocumentOverlayCardClassName } from './document-overlay-styles'

describe('getDocumentOverlayCardClassName', () => {
  it('marks the fullscreen document card as scenic-opaque', () => {
    expect(getDocumentOverlayCardClassName()).toContain('overlay-solid-surface')
  })
})
