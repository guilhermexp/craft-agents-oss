/**
 * Unit tests for turn-expansion polarity logic.
 *
 * Verifies isIdExpanded() resolves the correct default given autoExpand and the
 * two override sets, and applyExpansionToggle() mutates only the active set,
 * returns a fresh reference for it, and preserves the other set verbatim so the
 * user's per-id intent survives an autoExpand flip.
 */

import { describe, it, expect } from 'bun:test'
import { isIdExpanded, applyExpansionToggle, type ExpansionState } from '../turn-expansion'

const emptyState = (): ExpansionState => ({ expanded: new Set(), collapsed: new Set() })

describe('isIdExpanded', () => {
  it('defaults to collapsed when autoExpand is off', () => {
    expect(isIdExpanded(emptyState(), false, 'g1')).toBe(false)
  })

  it('reads expanded when the id is in the expanded set and autoExpand is off', () => {
    const state: ExpansionState = { expanded: new Set(['g1']), collapsed: new Set() }
    expect(isIdExpanded(state, false, 'g1')).toBe(true)
    expect(isIdExpanded(state, false, 'g2')).toBe(false)
  })

  it('defaults to expanded when autoExpand is on', () => {
    expect(isIdExpanded(emptyState(), true, 'g1')).toBe(true)
  })

  it('reads collapsed when the id is in the collapsed set and autoExpand is on', () => {
    const state: ExpansionState = { expanded: new Set(), collapsed: new Set(['g1']) }
    expect(isIdExpanded(state, true, 'g1')).toBe(false)
    expect(isIdExpanded(state, true, 'g2')).toBe(true)
  })
})

describe('applyExpansionToggle (autoExpand off)', () => {
  it('adds an id to the expanded set when expanding', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, false, 'g1', true)
    expect(next.expanded.has('g1')).toBe(true)
    expect(isIdExpanded(next, false, 'g1')).toBe(true)
  })

  it('removes an id from the expanded set when collapsing', () => {
    const state: ExpansionState = { expanded: new Set(['g1']), collapsed: new Set() }
    const next = applyExpansionToggle(state, false, 'g1', false)
    expect(next.expanded.has('g1')).toBe(false)
    expect(isIdExpanded(next, false, 'g1')).toBe(false)
  })

  it('leaves the collapsed set byref-identical', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, false, 'g1', true)
    expect(next.collapsed).toBe(state.collapsed)
  })

  it('returns a NEW reference for the active (expanded) set and does not mutate input', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, false, 'g1', true)
    expect(next.expanded).not.toBe(state.expanded)
    expect(state.expanded.size).toBe(0)
  })
})

describe('applyExpansionToggle (autoExpand on)', () => {
  it('adds an id to the collapsed set when collapsing', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, true, 'g1', false)
    expect(next.collapsed.has('g1')).toBe(true)
    expect(isIdExpanded(next, true, 'g1')).toBe(false)
  })

  it('removes an id from the collapsed set when expanding', () => {
    const state: ExpansionState = { expanded: new Set(), collapsed: new Set(['g1']) }
    const next = applyExpansionToggle(state, true, 'g1', true)
    expect(next.collapsed.has('g1')).toBe(false)
    expect(isIdExpanded(next, true, 'g1')).toBe(true)
  })

  it('leaves the expanded set byref-identical', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, true, 'g1', false)
    expect(next.expanded).toBe(state.expanded)
  })

  it('returns a NEW reference for the active (collapsed) set and does not mutate input', () => {
    const state = emptyState()
    const next = applyExpansionToggle(state, true, 'g1', false)
    expect(next.collapsed).not.toBe(state.collapsed)
    expect(state.collapsed.size).toBe(0)
  })
})

describe("per-id intent survives an autoExpand flip", () => {
  it('preserves the opposite override set across the flip and restores intent when flipped back', () => {
    // User works under autoExpand=off and explicitly expands g1.
    let state = emptyState()
    state = applyExpansionToggle(state, false, 'g1', true)
    expect(isIdExpanded(state, false, 'g1')).toBe(true)

    // Flip global autoExpand ON. Now defaults are expanded; the collapsed set
    // (empty) is what drives reads. The user's expanded intent must be untouched.
    expect(state.expanded.has('g1')).toBe(true)
    expect(isIdExpanded(state, true, 'g1')).toBe(true) // default-expanded, not in collapsed

    // Under autoExpand ON the user explicitly collapses g2. This must only touch
    // the collapsed set and leave the expanded set (holding g1) byref-identical.
    const expandedBefore = state.expanded
    state = applyExpansionToggle(state, true, 'g2', false)
    expect(state.expanded).toBe(expandedBefore)
    expect(state.collapsed.has('g2')).toBe(true)

    // Flip autoExpand back OFF: g1's original expand intent is still resolvable.
    expect(isIdExpanded(state, false, 'g1')).toBe(true)
    // g2 was never in the expanded set, so it reads collapsed under autoExpand off.
    expect(isIdExpanded(state, false, 'g2')).toBe(false)
  })
})
