/**
 * Theme-signal parsing unit tests.
 *
 * These defend the pure `parseThemeSignal` decoder for the in-page theme-color
 * console signal — no Electron, no BrowserPaneManager instance. The observer
 * emits `__craft_theme_color__:<token>:<color|__NULL__>`; the console handler
 * relies on this decoder to route colors and skip normal log capture.
 */

import { describe, it, expect } from 'bun:test'
import { parseThemeSignal, BrowserThemeExtractor } from '../theme-extractor'
import type { BrowserInstance } from '../../browser-pane-manager'

describe('parseThemeSignal', () => {
  it('parses a valid color signal into token + color', () => {
    expect(parseThemeSignal('__craft_theme_color__:tok:#123456')).toEqual({ token: 'tok', color: '#123456' })
  })

  it('maps the __NULL__ sentinel to color: null', () => {
    expect(parseThemeSignal('__craft_theme_color__:tok:__NULL__')).toEqual({ token: 'tok', color: null })
  })

  it('returns null for a non-signal message', () => {
    expect(parseThemeSignal('some ordinary console log')).toBeNull()
  })

  it('returns null when the token delimiter is missing', () => {
    expect(parseThemeSignal('__craft_theme_color__:tokwithoutcolor')).toBeNull()
  })
})

describe('BrowserThemeExtractor.handleConsoleSignal', () => {
  function makeExtractor() {
    const stateChanges: string[] = []
    const extractor = new BrowserThemeExtractor({
      hasInstance: () => true,
      emitStateChange: (i) => stateChanges.push(i.id),
    })
    return { extractor, stateChanges }
  }

  function makeInstance(token: string) {
    const sent: Array<string | null> = []
    // Minimal structural stub — only the fields apply()/handleConsoleSignal read.
    const instance = {
      id: 'inst-1',
      themeObserverToken: token,
      themeColor: null as string | null,
      window: { isDestroyed: () => false },
      toolbarView: { webContents: { isDestroyed: () => false, send: (_c: string, color: string | null) => { sent.push(color) } } },
    } as unknown as BrowserInstance
    return { instance, sent }
  }

  it('applies the color and pushes it to the toolbar when the token matches', () => {
    const { extractor, stateChanges } = makeExtractor()
    const { instance, sent } = makeInstance('tok')
    expect(extractor.handleConsoleSignal(instance, '__craft_theme_color__:tok:#123456')).toBe(true)
    expect(instance.themeColor).toBe('#123456')
    expect(sent).toEqual(['#123456'])
    expect(stateChanges).toEqual(['inst-1'])
  })

  it('ignores a signal from a stale token but still marks it handled', () => {
    const { extractor } = makeExtractor()
    const { instance, sent } = makeInstance('current')
    instance.themeColor = '#aaaaaa'
    expect(extractor.handleConsoleSignal(instance, '__craft_theme_color__:old:#bbccdd')).toBe(true)
    expect(instance.themeColor).toBe('#aaaaaa')
    expect(sent).toEqual([])
  })

  it('clears the color on the __NULL__ sentinel', () => {
    const { extractor } = makeExtractor()
    const { instance } = makeInstance('tok')
    instance.themeColor = '#123456'
    extractor.handleConsoleSignal(instance, '__craft_theme_color__:tok:__NULL__')
    expect(instance.themeColor).toBeNull()
  })

  it('dedupes a repeated identical color (single toolbar send)', () => {
    const { extractor } = makeExtractor()
    const { instance, sent } = makeInstance('tok')
    extractor.handleConsoleSignal(instance, '__craft_theme_color__:tok:#445566')
    extractor.handleConsoleSignal(instance, '__craft_theme_color__:tok:#445566')
    expect(sent).toEqual(['#445566'])
  })

  it('returns false for a non-theme console message', () => {
    const { extractor } = makeExtractor()
    const { instance } = makeInstance('tok')
    expect(extractor.handleConsoleSignal(instance, 'regular log line')).toBe(false)
  })
})
