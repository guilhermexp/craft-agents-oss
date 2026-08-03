import { describe, expect, it } from 'bun:test'
import type { InlinePreviewLoadKind } from '../right-sidebar-preview-state'

interface PreviewSelection {
  sessionId: string
  filePath: string
}

interface PreviewStateModule {
  getActiveRightSidebarPreviewPath: (input: {
    selection: PreviewSelection | null
    sessionId: string | null
    isVisible: boolean
  }) => string | null
  // Imported, not restated: a local copy of this union silently goes stale
  // when the panel learns a new kind.
  getInlinePreviewLoadState: (filePath: string) => {
    kind: InlinePreviewLoadKind
    loading: boolean
  }
}

const previewStateModulePath = '../right-sidebar-preview-state'

async function loadPreviewStateModule(): Promise<PreviewStateModule | null> {
  try {
    return await import(previewStateModulePath) as unknown as PreviewStateModule
  } catch {
    return null
  }
}

describe('right sidebar preview state', () => {
  it('exposes preview state helpers', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
  })

  it('only exposes a selected path for the visible current session', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    const selection = { sessionId: 'session-a', filePath: '/repo/notes.md' }
    expect(previewState.getActiveRightSidebarPreviewPath({ selection, sessionId: 'session-a', isVisible: true })).toBe('/repo/notes.md')
    expect(previewState.getActiveRightSidebarPreviewPath({ selection, sessionId: 'session-b', isVisible: true })).toBeNull()
    expect(previewState.getActiveRightSidebarPreviewPath({ selection, sessionId: 'session-a', isVisible: false })).toBeNull()
  })

  it('starts loading for every kind the panel renders, and only bails on the ones it cannot', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    expect(previewState.getInlinePreviewLoadState('/repo/notes.md')).toEqual({ kind: 'text', loading: true })
    expect(previewState.getInlinePreviewLoadState('/repo/image.png')).toEqual({ kind: 'image', loading: true })
    // The panel renders PDFs itself now; binary loading is its own kind.
    expect(previewState.getInlinePreviewLoadState('/repo/report.pdf')).toEqual({ kind: 'pdf', loading: true })
    expect(previewState.getInlinePreviewLoadState('/repo/recording.mp3')).toEqual({ kind: 'unsupported', loading: false })
    expect(previewState.getInlinePreviewLoadState('/repo/archive.zip')).toEqual({ kind: 'unsupported', loading: false })
  })
})

describe('inline preview source contract', () => {
  it('uses direct UI imports, translated labels, and Markdown link handlers', async () => {
    const source = await Bun.file(new URL('../SessionInfoPopover.tsx', import.meta.url)).text()

    expect(source).not.toContain("from '@craft-agent/ui'")
    expect(source).not.toContain('Switch to dialog')
    expect(source).not.toContain('This file type opens in the dialog preview.')
    expect(source).toContain('onUrlClick=')
    expect(source).toContain('onFileClick=')
  })
})
