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

  it('previews PDFs inline now that the panel renders them, and keeps audio on its dialog viewer', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/report.pdf', canPreviewInline: true })).toBe('inline-preview')
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/recording.mp3', canPreviewInline: true })).toBe('app-open-file')
  })

  it('keeps unsupported files on the existing open-file path', () => {
    expect(getSessionFileOpenMode({ type: 'file', filePath: '/repo/archive.zip', canPreviewInline: true })).toBe('app-open-file')
  })
})

describe('getRightSidebarFilePaneLayout', () => {
  it('collapses the file tree by default beside a fresh preview', () => {
    // Opening a file from chat asks for that file. Handing back a split panel
    // put a file tree nobody requested next to it.
    for (const kind of ['file', 'object', 'browser'] as const) {
      expect(getRightSidebarFilePaneLayout(kind)).toEqual({
        mode: 'preview-only',
        showTree: false,
        showPreview: true,
      })
    }
  })

  it('uses the full width for the file tree before a preview is selected', () => {
    expect(getRightSidebarFilePaneLayout(null)).toEqual({
      mode: 'tree-only',
      showTree: true,
      showPreview: false,
    })
  })

  it('lets an explicit expand win for any content kind', () => {
    for (const kind of ['file', 'object', 'browser'] as const) {
      expect(getRightSidebarFilePaneLayout(kind, false)).toEqual({
        mode: 'split',
        showTree: true,
        showPreview: true,
      })
    }
  })

  it('keeps an explicit collapse collapsed', () => {
    expect(getRightSidebarFilePaneLayout('file', true)).toEqual({
      mode: 'preview-only',
      showTree: false,
      showPreview: true,
    })
  })

  it('never collapses the tree away when there is nothing to preview', () => {
    expect(getRightSidebarFilePaneLayout(null, true)).toEqual({
      mode: 'tree-only',
      showTree: true,
      showPreview: false,
    })
  })
})
