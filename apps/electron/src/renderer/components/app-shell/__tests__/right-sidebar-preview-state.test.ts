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
  resolveVideoPreview: (filePath: string, failed: boolean) =>
    | { mode: 'play'; src: string }
    | { mode: 'fallback' }
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

  it('routes Office documents through the OfficeCLI render kind', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    expect(previewState.getInlinePreviewLoadState('/repo/budget.xlsx')).toEqual({ kind: 'office', loading: true })
    expect(previewState.getInlinePreviewLoadState('/repo/report.docx')).toEqual({ kind: 'office', loading: true })
    expect(previewState.getInlinePreviewLoadState('/repo/deck.pptx')).toEqual({ kind: 'office', loading: true })

    // Formats OfficeCLI rejects must not reach the render path.
    expect(previewState.getInlinePreviewLoadState('/repo/legacy.xls')).toEqual({ kind: 'unsupported', loading: false })
    expect(previewState.getInlinePreviewLoadState('/repo/macro.xlsm')).toEqual({ kind: 'unsupported', loading: false })
  })

  it('renders .html as a page, not as source', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    expect(previewState.getInlinePreviewLoadState('/repo/page.html')).toEqual({ kind: 'html', loading: true })
  })

  it('does not pre-load video — the element streams it over media://', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    expect(previewState.getInlinePreviewLoadState('/repo/clip.mp4')).toEqual({ kind: 'video', loading: false })
    expect(previewState.getInlinePreviewLoadState('/repo/clip.mov')).toEqual({ kind: 'video', loading: false })
    // Codecs Chromium cannot decode still route to the system opener.
    expect(previewState.getInlinePreviewLoadState('/repo/clip.mkv')).toEqual({ kind: 'unsupported', loading: false })
  })

  it('streams a workspace video over media:// with a losslessly recoverable path', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    const result = previewState.resolveVideoPreview('/tmp/my clip #2?.mp4', false)
    expect(result.mode).toBe('play')
    if (result.mode !== 'play') return
    expect(result.src.startsWith('media://workspace/')).toBe(true)
    // The main-process handler recovers the absolute path with one decode; if
    // encoding drops a space or '#'/'?' the file resolves wrong or 403s.
    const recovered = decodeURIComponent(result.src.slice('media://workspace/'.length))
    expect(recovered).toBe('/tmp/my clip #2?.mp4')
  })

  it('falls back instead of a silently broken player once the element reports failure', async () => {
    const previewState = await loadPreviewStateModule()
    expect(previewState).not.toBeNull()
    if (!previewState) return

    // A video outside ~/.craft-agent/workspaces makes media:// answer 403 and the
    // <video> fire `error`; the panel must offer the external opener, not a dead
    // control with no loading/error state.
    expect(previewState.resolveVideoPreview('/anywhere/outside/clip.mp4', true)).toEqual({ mode: 'fallback' })
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
