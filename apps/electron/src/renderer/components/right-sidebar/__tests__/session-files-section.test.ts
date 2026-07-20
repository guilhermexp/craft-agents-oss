import { describe, expect, it } from 'bun:test'
import { getRightSidebarFilePaneLayout, getSessionFileOpenMode } from '../SessionFilesSection'

describe('getSessionFileOpenMode', () => {
  it('opens files inline when the embedding panel provides an inline preview target', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/notes.md', canPreviewInline: true })).toBe('inline-preview')
  })

  it('keeps popover file clicks on the existing overlay path', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/notes.md', canPreviewInline: false })).toBe('app-open-file')
  })

  it('keeps directories on the directory path', () => {
    expect(getSessionFileOpenMode({ type: 'directory', filePath: '/repo/src', canPreviewInline: true })).toBe('directory')
  })

  it('keeps PDF and audio files on their specialized dialog viewers', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/report.pdf', canPreviewInline: true })).toBe('app-open-file')
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/recording.mp3', canPreviewInline: true })).toBe('app-open-file')
  })

  it('keeps unsupported files on the existing open-file path', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/archive.zip', canPreviewInline: true })).toBe('app-open-file')
  })
})

describe('getRightSidebarFilePaneLayout', () => {
  it('keeps the file tree visible beside an inline preview', () => {
    expect(getRightSidebarFilePaneLayout('/repo/AGENTS.md')).toEqual({
      mode: 'split',
      showTree: true,
      showPreview: true,
    })
  })

  it('uses the full width for the file tree before a preview is selected', () => {
    expect(getRightSidebarFilePaneLayout(null)).toEqual({
      mode: 'tree-only',
      showTree: true,
      showPreview: false,
    })
  })
})
