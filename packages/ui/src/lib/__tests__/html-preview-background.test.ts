import { describe, expect, it } from 'bun:test'
import { resolveHtmlPreviewBackground } from '../html-preview-background'

describe('resolveHtmlPreviewBackground', () => {
  it('keeps the white paper frame for transparent fragments (emails)', () => {
    expect(resolveHtmlPreviewBackground('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)')).toBeNull()
    expect(resolveHtmlPreviewBackground('transparent', undefined)).toBeNull()
    expect(resolveHtmlPreviewBackground(undefined, undefined)).toBeNull()
  })

  it('keeps the white paper frame for near-white documents', () => {
    expect(resolveHtmlPreviewBackground('rgb(255, 255, 255)', 'rgb(255, 255, 255)')).toBeNull()
    expect(resolveHtmlPreviewBackground('rgb(250, 250, 250)', undefined)).toBeNull()
  })

  it('adopts an opaque dark page background (full-bleed reports)', () => {
    expect(resolveHtmlPreviewBackground('rgb(15, 15, 17)', 'rgb(255, 255, 255)')).toBe('rgb(15, 15, 17)')
  })

  it('falls back to the body background when <html> is transparent', () => {
    expect(resolveHtmlPreviewBackground('rgba(0, 0, 0, 0)', 'rgb(20, 24, 33)')).toBe('rgb(20, 24, 33)')
  })

  it('honors colored (non-white) light backgrounds', () => {
    expect(resolveHtmlPreviewBackground('rgb(240, 240, 240)', undefined)).toBe('rgb(240, 240, 240)')
  })
})
