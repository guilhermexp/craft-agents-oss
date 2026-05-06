import { describe, expect, it } from 'bun:test'
import { prepareHtmlPreviewSrcDoc } from '../html-preview-sanitizer'

describe('prepareHtmlPreviewSrcDoc', () => {
  it('removes script tags before sandboxed preview rendering', () => {
    const html = '<html><head><script>console.log("blocked")</script></head><body><h1>Preview</h1><script src="/x.js"></script></body></html>'

    const result = prepareHtmlPreviewSrcDoc(html)

    expect(result).not.toContain('<script')
    expect(result).toContain('<base target="_top">')
    expect(result).toContain('<h1>Preview</h1>')
  })
})
