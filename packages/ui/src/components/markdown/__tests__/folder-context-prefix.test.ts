import { describe, it, expect } from 'bun:test'
import { prefixFolderContext } from '../folder-context-prefix'

describe('prefixFolderContext', () => {
  it('rewrites bullet basenames after a Pasta: marker', () => {
    const input = [
      'Feito — criei mockups de todas as páginas.',
      '',
      'Pasta:',
      '/Users/foo/proj/mockups/',
      '',
      'Inclui:',
      '- 00-overview.png',
      '- 01-dashboard.png',
    ].join('\n')

    const out = prefixFolderContext(input)
    expect(out).toContain('- [00-overview.png](/Users/foo/proj/mockups/00-overview.png)')
    expect(out).toContain('- [01-dashboard.png](/Users/foo/proj/mockups/01-dashboard.png)')
  })

  it('handles inline Pasta: /abs/path on a single line', () => {
    const input = [
      'Pasta: /Users/foo/mockups/',
      '- a.png',
      '- b.jpg',
    ].join('\n')

    const out = prefixFolderContext(input)
    expect(out).toContain('- [a.png](/Users/foo/mockups/a.png)')
    expect(out).toContain('- [b.jpg](/Users/foo/mockups/b.jpg)')
  })

  it('supports Folder: and Directory: labels (en)', () => {
    const input = 'Folder: /tmp/out\n- one.png\n\nDirectory: /var/log\n- two.jpg'
    const out = prefixFolderContext(input)
    expect(out).toContain('- [one.png](/tmp/out/one.png)')
    expect(out).toContain('- [two.jpg](/var/log/two.jpg)')
  })

  it('preserves backticks around the basename', () => {
    const input = 'Pasta: /a/b\n- `report.png`'
    const out = prefixFolderContext(input)
    expect(out).toContain('- [`report.png`](/a/b/report.png)')
  })

  it('skips items already wrapped in a markdown link', () => {
    const input = 'Pasta: /a/b\n- [report.png](/a/b/report.png)'
    const out = prefixFolderContext(input)
    expect(out).toBe(input)
  })

  it('skips fenced code blocks', () => {
    const input = [
      'Pasta: /a/b',
      '```',
      '- code-only.png',
      '```',
      '- real.png',
    ].join('\n')
    const out = prefixFolderContext(input)
    expect(out).toContain('- code-only.png')
    expect(out).not.toContain('[code-only.png]')
    expect(out).toContain('- [real.png](/a/b/real.png)')
  })

  it('skips when folder value is not absolute', () => {
    const input = 'Pasta: ./relative/\n- a.png'
    const out = prefixFolderContext(input)
    expect(out).toBe(input)
  })

  it('only rewrites items below the marker, not before', () => {
    const input = '- before.png\nPasta: /a/b\n- after.png'
    const out = prefixFolderContext(input)
    expect(out).toContain('- before.png')
    expect(out).not.toContain('[before.png]')
    expect(out).toContain('- [after.png](/a/b/after.png)')
  })

  it('handles paths with spaces using angle brackets', () => {
    const input = 'Pasta: /Users/foo/My Folder\n- shot.png'
    const out = prefixFolderContext(input)
    expect(out).toContain('- [shot.png](</Users/foo/My Folder/shot.png>)')
  })

  it('switches active folder when a new marker appears', () => {
    const input = [
      'Pasta: /a',
      '- one.png',
      'Pasta: /b',
      '- two.png',
    ].join('\n')
    const out = prefixFolderContext(input)
    expect(out).toContain('- [one.png](/a/one.png)')
    expect(out).toContain('- [two.png](/b/two.png)')
  })

  it('returns input untouched when no folder marker is present', () => {
    const input = 'Some text\n- foo.png\n- bar.jpg'
    expect(prefixFolderContext(input)).toBe(input)
  })

  it('is idempotent', () => {
    const input = 'Pasta: /a/b\n- c.png'
    const once = prefixFolderContext(input)
    const twice = prefixFolderContext(once)
    expect(twice).toBe(once)
  })

  it('supports Diretório: with accent', () => {
    const input = 'Diretório: /a/b\n- c.png'
    const out = prefixFolderContext(input)
    expect(out).toContain('- [c.png](/a/b/c.png)')
  })
})
