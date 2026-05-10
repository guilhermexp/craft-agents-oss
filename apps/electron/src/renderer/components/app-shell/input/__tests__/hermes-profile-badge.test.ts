import { describe, expect, it } from 'bun:test'

import {
  getHermesProfileBadgeLabel,
  getHermesProfileModel,
  getHermesProfileSelectorLabel,
  mergeHermesProfileModels,
  resolveHermesProfileSelection,
} from '../hermes-profile-badge'

describe('resolveHermesProfileSelection', () => {
  it('prefers the session-pinned Hermes profile over the active profile', () => {
    expect(resolveHermesProfileSelection('devops', 'default')).toBe('devops')
  })

  it('falls back to the active Hermes profile before a session is pinned', () => {
    expect(resolveHermesProfileSelection(undefined, 'research')).toBe('research')
  })
})

describe('getHermesProfileSelectorLabel', () => {
  it('shows the persisted Hermes profile for Hermes sessions', () => {
    expect(getHermesProfileSelectorLabel('hermes', 'devops', 'default')).toBe('Hermes: devops')
  })

  it('shows the active Hermes profile when the session has not been pinned yet', () => {
    expect(getHermesProfileSelectorLabel('hermes', undefined, 'writer')).toBe('Hermes: writer')
  })

  it('shows default explicitly when neither a session nor active profile is known', () => {
    expect(getHermesProfileSelectorLabel('hermes')).toBe('Hermes: default')
  })

  it('shows a loading label for Hermes while profiles are loading', () => {
    expect(getHermesProfileSelectorLabel('hermes', undefined, undefined, true)).toBe('Hermes: …')
  })

  it('does not show a Hermes selector for non-Hermes providers', () => {
    expect(getHermesProfileSelectorLabel('anthropic', 'devops', 'default')).toBeNull()
  })
})

describe('getHermesProfileBadgeLabel', () => {
  it('keeps the previous badge helper behavior for pinned profiles', () => {
    expect(getHermesProfileBadgeLabel('hermes', 'default')).toBe('Hermes: default')
  })
})

describe('getHermesProfileModel', () => {
  it('returns the configured model for the selected Hermes profile', () => {
    expect(getHermesProfileModel([
      { name: 'default', model: 'gpt-5.5' },
      { name: 'coding', model: 'claude-opus-4-7' },
    ], 'coding')).toBe('claude-opus-4-7')
  })

  it('returns null when the profile has no configured model', () => {
    expect(getHermesProfileModel([{ name: 'default', model: '  ' }], 'default')).toBeNull()
  })
})

describe('mergeHermesProfileModels', () => {
  it('adds distinct profile models to the connection model list', () => {
    expect(mergeHermesProfileModels(['gpt-5.5'], [
      { name: 'default', model: 'gpt-5.5' },
      { name: 'coding', model: 'claude-opus-4-7' },
    ])).toEqual(['gpt-5.5', 'claude-opus-4-7'])
  })

  it('deduplicates object model entries by id', () => {
    const opus = { id: 'claude-opus-4-7', name: 'Opus' }
    expect(mergeHermesProfileModels([opus], [
      { name: 'coding', model: 'claude-opus-4-7' },
      { name: 'default', model: 'gpt-5.5' },
    ])).toEqual([opus, 'gpt-5.5'])
  })
})
