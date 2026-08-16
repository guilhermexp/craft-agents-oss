/**
 * Rendered proof of the auto-expand window at the TurnCard boundary.
 *
 * The polarity unit tests in `turn-expansion.test.ts` cover the state machine;
 * this suite asserts the user-visible consequence — a working turn renders its
 * activity list, the same turn renders it collapsed once it settles — through
 * the exact composition the chat performs:
 *
 *   isExpanded = isIdExpanded(state, autoExpandApplies(setting, !turn.isComplete), key)
 *
 * Leaving `autoExpand` unscoped — the previous behavior, where the setting kept
 * the whole transcript exploded — typechecks and fails here. The separate
 * question of WHICH turn flag opens the window (`!isComplete`, never
 * `isStreaming`) is a contract of `autoExpandApplies` and is covered by its own
 * unit tests; this suite takes the in-flight state as given.
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { isIdExpanded, applyExpansionToggle, autoExpandApplies, type ExpansionState } from '../turn-expansion'
import type { ActivityItem } from '../turn-card-shared'
import type { TurnCardProps } from '../TurnCard'

// TurnCard -> ResponseCard -> Markdown -> MarkdownPdfBlock -> react-pdf ->
// pdfjs-dist. Same bun limitation documented in user-message-markdown.test.tsx:
// Vite's `?url` suffix is not a real specifier and pdfjs evaluates
// `new DOMMatrix()` at module scope. Mock the edge the UI actually imports.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' }, version: '0.0.0-test' },
}))

let TurnCard: (props: TurnCardProps) => React.ReactNode

// Dynamic import: `mock.module` must register before TurnCard's module graph is
// evaluated, so the specifier cannot be a static import here.
beforeAll(async () => {
  const mod = await import('../TurnCard')
  TurnCard = mod.TurnCard as unknown as (props: TurnCardProps) => React.ReactNode
})

const TURN_KEY = 'turn-t1-1000'
const i18n = createInstance({
  lng: 'en',
  resources: { en: { translation: {} } },
  interpolation: { escapeValue: false },
})
void i18n.init()

const activities: ActivityItem[] = [
  {
    id: 'a1',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolInput: { command: 'echo marker-activity-row' },
    timestamp: 1000,
  },
]

const emptyState = (): ExpansionState => ({ expanded: new Set(), collapsed: new Set() })

/**
 * Render a turn the way the chat does: `isComplete` drives both the card's own
 * streaming props and the auto-expand window, so the two can never disagree.
 */
function renderTurn(options: {
  state: ExpansionState
  autoExpand: boolean
  isComplete: boolean
}): string {
  const { state, autoExpand, isComplete } = options
  const isTurnInFlight = !isComplete
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TurnCard
        turnId="t1"
        activities={activities}
        isStreaming={isTurnInFlight}
        isComplete={isComplete}
        isExpanded={isIdExpanded(state, autoExpandApplies(autoExpand, isTurnInFlight), TURN_KEY)}
      />
    </I18nextProvider>,
  )
}

/** The activity list only exists in the tree while the card is expanded. */
const showsActivityList = (markup: string) => markup.includes('marker-activity-row')

describe('TurnCard under the auto-expand window', () => {
  it('renders the activity list while the turn is working', () => {
    expect(showsActivityList(renderTurn({ state: emptyState(), autoExpand: true, isComplete: false }))).toBe(true)
  })

  it('drops the activity list once the turn completes', () => {
    expect(showsActivityList(renderTurn({ state: emptyState(), autoExpand: true, isComplete: true }))).toBe(false)
  })

  it('still shows the collapsed header for a settled turn', () => {
    // Auto-collapse must hide the activities, not the card: the toggle stays
    // available so the user can reopen the turn.
    const markup = renderTurn({ state: emptyState(), autoExpand: true, isComplete: true })
    expect(markup).toContain('<button')
    expect(showsActivityList(markup)).toBe(false)
  })

  it('keeps a working turn collapsed when the user collapsed it', () => {
    const state = applyExpansionToggle(emptyState(), autoExpandApplies(true, true), TURN_KEY, false)
    expect(showsActivityList(renderTurn({ state, autoExpand: true, isComplete: false }))).toBe(false)
  })

  it('reopens a settled turn the user expanded by hand', () => {
    const state = applyExpansionToggle(emptyState(), autoExpandApplies(true, false), TURN_KEY, true)
    expect(showsActivityList(renderTurn({ state, autoExpand: true, isComplete: true }))).toBe(true)
  })

  it('leaves a working turn collapsed when the setting is off', () => {
    expect(showsActivityList(renderTurn({ state: emptyState(), autoExpand: false, isComplete: false }))).toBe(false)
  })
})
