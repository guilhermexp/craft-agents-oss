import { describe, expect, it } from 'bun:test'
import { resolveActivityPreviewPath } from '../activity-tree'

describe('resolveActivityPreviewPath', () => {
  it('resolves relative Read paths against the session folder', () => {
    expect(resolveActivityPreviewPath('images/frame.png', '/workspace/session')).toBe(
      '/workspace/session/images/frame.png',
    )
  })

  it('preserves absolute Read paths', () => {
    expect(resolveActivityPreviewPath('/tmp/frame.png', '/workspace/session')).toBe('/tmp/frame.png')
  })
})
