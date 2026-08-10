/**
 * User messages must render as rich markdown, same as agent output.
 *
 * Regression guard: the bubble used to carry `[&_p]:m-0`, which zeroed the
 * `my-2` that `Markdown`'s minimal mode puts on paragraphs. Every block
 * collapsed into a single wall of text even though the markdown itself parsed
 * correctly.
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UserMessageBubbleProps } from '../UserMessageBubble'

// UserMessageBubble -> Markdown -> MarkdownPdfBlock -> react-pdf -> pdfjs-dist.
// Same bun limitation documented in renderer mention-menu.test.ts: Vite's `?url`
// suffix is not a real specifier and pdfjs evaluates `new DOMMatrix()` at module
// scope. Mock the edge the UI actually imports.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' }, version: '0.0.0-test' },
}))

let UserMessageBubble: (props: UserMessageBubbleProps) => React.ReactNode

beforeAll(async () => {
  const mod = await import('../UserMessageBubble')
  UserMessageBubble = mod.UserMessageBubble
})

const MARKDOWN_SAMPLE = [
  '## Titulo',
  '',
  'Primeiro paragrafo com **negrito** e `inline`.',
  '',
  'Segundo paragrafo.',
  '',
  '- bullet a',
  '- bullet b',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n')

describe('UserMessageBubble markdown rendering', () => {
  it('renders block-level markdown structure', () => {
    const html = renderToStaticMarkup(<UserMessageBubble content={MARKDOWN_SAMPLE} />)

    expect(html).toContain('<h2')
    expect(html).toContain('<ul')
    expect(html).toContain('<table')
    expect(html).toContain('<strong')
    expect(html).toContain('typescript')
  })

  it('keeps paragraph spacing instead of collapsing blocks', () => {
    const html = renderToStaticMarkup(<UserMessageBubble content={MARKDOWN_SAMPLE} />)

    // Both paragraphs keep the markdown block margin.
    expect(html.match(/class="my-2 leading-relaxed"/g)).toHaveLength(2)
    // The bubble must not re-zero it.
    expect(html).not.toContain('_p]:m-0')
  })

  it('collapses only the outer block margins into the bubble padding', () => {
    const html = renderToStaticMarkup(<UserMessageBubble content={MARKDOWN_SAMPLE} />)

    expect(html).toContain('*:first-child]:mt-0')
    expect(html).toContain('*:last-child]:mb-0')
  })

  it('preserves the soft line breaks the user typed', () => {
    const html = renderToStaticMarkup(<UserMessageBubble content={'linha 1\nlinha 2'} />)

    expect(html).toContain('_p]:whitespace-pre-wrap')
    expect(html).toContain('linha 1\nlinha 2')
  })
})
