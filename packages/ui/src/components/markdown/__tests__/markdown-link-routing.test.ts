import { describe, it, expect } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { classifyMarkdownLinkTarget, resolveMarkdownLinkTarget } from '../link-target'
import { markdownUrlTransform } from '../url-transform'

describe('resolveMarkdownLinkTarget', () => {
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.craft-agent/sessions/abc/image.jpg',
    })
  })

  it('resolves absolute unix file paths with spaces as file targets', () => {
    expect(resolveMarkdownLinkTarget('/var/folders/tmp/Captura de Tela 2026-04-30 as 21.28.24.png')).toEqual({
      kind: 'file',
      path: '/var/folders/tmp/Captura de Tela 2026-04-30 as 21.28.24.png',
    })
  })

  it('resolves quoted absolute unix file paths with spaces as file targets', () => {
    expect(resolveMarkdownLinkTarget('"/var/folders/tmp/Captura de Tela 2026-05-01 às 01.13.54.png"')).toEqual({
      kind: 'file',
      path: '/var/folders/tmp/Captura de Tela 2026-05-01 às 01.13.54.png',
    })
  })

  it('decodes escaped unicode sequences in quoted file paths', () => {
    expect(resolveMarkdownLinkTarget('"/var/folders/tmp/Captura de Tela 2026-05-01 a\\u{300}s 02.20.15.png"')).toEqual({
      kind: 'file',
      path: '/var/folders/tmp/Captura de Tela 2026-05-01 às 02.20.15.png',
    })
  })

  it('resolves quoted file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('"file:///Users/tester/report%20final.pdf"')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('normalizes windows drive-letter file URLs to local paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:/Users/Tester/Deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('markdownUrlTransform', () => {
  // Hardened by 73142e5e ("block XSS schemes in markdownUrlTransform"): only
  // file: is re-allowed from the set react-markdown's default transform
  // strips, because file: is the scheme the custom <a> routes via onFileClick.
  // XSS-class schemes are stripped at this layer regardless of what the
  // consuming component does. See url-transform.test.ts for the full matrix.
  it('preserves file hrefs for custom click routing but strips XSS schemes', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('file:///tmp/test.md', 'href', anchorNode as never)).toBe('file:///tmp/test.md')
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode as never)).toBe('')
  })

  it('still sanitizes dangerous non-anchor URL attributes', () => {
    const imageNode = { tagName: 'img' }
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imageNode as never)).toBe('')
  })

  it('keeps safe anchor hrefs unchanged', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('https://example.com', 'href', anchorNode as never)).toBe('https://example.com')
  })
})

describe('ReactMarkdown anchor rendering with markdownUrlTransform', () => {
  function render(markdown: string): string {
    return renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => React.createElement('a', {
          href: href ? defaultUrlTransform(href) || undefined : undefined,
          'data-raw-href': href,
        }, children),
      },
    }, markdown))
  }

  it('lets file links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[report](file:///Users/tester/report.pdf)')
    expect(html).toContain('data-raw-href="file:///Users/tester/report.pdf"')
    expect(html).not.toContain('<a href="file:///Users/tester/report.pdf"')
  })

  it('never lets javascript links reach the custom anchor', () => {
    const html = render('[boom](javascript:alert(1))')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('<a href="javascript:alert')
    expect(html).toContain('data-raw-href=""')
  })

  it('keeps safe web links in the DOM href for normal browser affordances', () => {
    const html = render('[site](https://example.com/path)')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies absolute unix file paths with spaces as file', () => {
    expect(classifyMarkdownLinkTarget('/var/folders/tmp/Captura de Tela 2026-04-30 as 21.28.24.png')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})
