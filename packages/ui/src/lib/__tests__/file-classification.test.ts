import { describe, expect, it } from 'bun:test'
import { classifyFile, isOfficePreviewType } from '../file-classification'

describe('classifyFile', () => {
  it('routes audio files to the in-app audio preview', () => {
    expect(classifyFile('/tmp/output.mp3')).toEqual({ type: 'audio', canPreview: true })
    expect(classifyFile('/tmp/output.wav')).toEqual({ type: 'audio', canPreview: true })
    expect(classifyFile('/tmp/output.m4a')).toEqual({ type: 'audio', canPreview: true })
  })

  it('routes Chromium-decodable video to the in-app video preview', () => {
    expect(classifyFile('/tmp/output.mp4')).toEqual({ type: 'video', canPreview: true })
    expect(classifyFile('/tmp/output.mov')).toEqual({ type: 'video', canPreview: true })
    expect(classifyFile('/tmp/output.webm')).toEqual({ type: 'video', canPreview: true })
  })

  it('keeps codecs Chromium cannot decode external', () => {
    expect(classifyFile('/tmp/output.avi')).toEqual({ type: null, canPreview: false })
    expect(classifyFile('/tmp/output.mkv')).toEqual({ type: null, canPreview: false })
    expect(classifyFile('/tmp/photo.heic')).toEqual({ type: null, canPreview: false })
  })

  describe('Office documents', () => {
    it('routes the three OpenXML formats OfficeCLI renders', () => {
      expect(classifyFile('/tmp/budget.xlsx')).toEqual({ type: 'spreadsheet', canPreview: true })
      expect(classifyFile('/tmp/report.docx')).toEqual({ type: 'richDocument', canPreview: true })
      expect(classifyFile('/tmp/deck.pptx')).toEqual({ type: 'presentation', canPreview: true })
    })

    it('keeps formats OfficeCLI rejects external', () => {
      // Macro/template variants and legacy OLE2 — the binary refuses these
      // outright, so routing them to the renderer would only surface an error.
      for (const path of [
        '/tmp/legacy.doc', '/tmp/legacy.xls', '/tmp/legacy.ppt',
        '/tmp/macro.xlsm', '/tmp/macro.docm', '/tmp/template.xltx',
        '/tmp/open.ods', '/tmp/open.odt', '/tmp/apple.numbers',
      ]) {
        expect(classifyFile(path)).toEqual({ type: null, canPreview: false })
      }
    })

    it('marks Office types as OfficeCLI-backed', () => {
      expect(isOfficePreviewType('spreadsheet')).toBe(true)
      expect(isOfficePreviewType('richDocument')).toBe(true)
      expect(isOfficePreviewType('presentation')).toBe(true)
      expect(isOfficePreviewType('code')).toBe(false)
      expect(isOfficePreviewType(null)).toBe(false)
    })
  })

  describe('priority order', () => {
    it('renders .html as a page rather than as source', () => {
      // .html is in CODE_EXTENSIONS too; the html branch has to win.
      expect(classifyFile('/tmp/page.html')).toEqual({ type: 'html', canPreview: true })
      expect(classifyFile('/tmp/page.htm')).toEqual({ type: 'html', canPreview: true })
    })

    it('previews .svg as an image rather than as source', () => {
      expect(classifyFile('/tmp/icon.svg')).toEqual({ type: 'image', canPreview: true })
    })

    it('treats .excalidraw as a drawing rather than as JSON', () => {
      expect(classifyFile('/tmp/sketch.excalidraw')).toEqual({ type: 'excalidraw', canPreview: true })
      expect(classifyFile('/tmp/sketch.excalidraw.md')).toEqual({ type: 'excalidraw', canPreview: true })
    })
  })

  it('falls back to text for plain-text formats', () => {
    expect(classifyFile('/tmp/notes.txt')).toEqual({ type: 'text', canPreview: true })
    expect(classifyFile('/tmp/data.csv')).toEqual({ type: 'text', canPreview: true })
  })

  it('returns no preview for unknown or extensionless paths', () => {
    expect(classifyFile('/tmp/mystery.qqq')).toEqual({ type: null, canPreview: false })
    expect(classifyFile('/tmp/Makefile.unknownext')).toEqual({ type: null, canPreview: false })
  })
})
