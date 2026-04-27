import { describe, expect, it } from 'bun:test'
import { buildPdfPreviewCodeFromPlainPath } from '../pdf-path-preview'

function parsePreview(code: string | null): unknown {
  return code ? JSON.parse(code) : null
}

describe('buildPdfPreviewCodeFromPlainPath', () => {
  it('builds a pdf-preview spec for a txt block with one absolute PDF path', () => {
    const result = buildPdfPreviewCodeFromPlainPath(
      '/Users/guilhermevarela/.codeclaw/workspace/sessions/260427-clear-coral/outputs/relatorio-lote-suzano-15360.pdf',
      'txt',
    )

    expect(parsePreview(result)).toEqual({
      src: '/Users/guilhermevarela/.codeclaw/workspace/sessions/260427-clear-coral/outputs/relatorio-lote-suzano-15360.pdf',
      title: 'relatorio-lote-suzano-15360.pdf',
    })
  })

  it('supports unlabeled fenced blocks and quoted paths', () => {
    const result = buildPdfPreviewCodeFromPlainPath(
      '"/Users/tester/reports/final report.pdf"',
      undefined,
    )

    expect(parsePreview(result)).toEqual({
      src: '/Users/tester/reports/final report.pdf',
      title: 'final report.pdf',
    })
  })

  it('supports Windows absolute PDF paths', () => {
    const result = buildPdfPreviewCodeFromPlainPath('C:\\Users\\Tester\\report.pdf', 'text')

    expect(parsePreview(result)).toEqual({
      src: 'C:\\Users\\Tester\\report.pdf',
      title: 'report.pdf',
    })
  })

  it('does not infer previews for non-plain languages', () => {
    expect(buildPdfPreviewCodeFromPlainPath('/Users/tester/report.pdf', 'bash')).toBeNull()
  })

  it('does not infer previews for relative paths or multi-line text', () => {
    expect(buildPdfPreviewCodeFromPlainPath('outputs/report.pdf', 'txt')).toBeNull()
    expect(buildPdfPreviewCodeFromPlainPath('/Users/tester/a.pdf\n/Users/tester/b.pdf', 'txt')).toBeNull()
  })
})
