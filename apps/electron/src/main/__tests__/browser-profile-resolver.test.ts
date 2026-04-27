import { describe, expect, it } from 'bun:test'
import {
  getProfilePartition,
  isProfilePartition,
  profileIdFromPartition,
  DEFAULT_BROWSER_PROFILE_PARTITION,
} from '../browser-profile-resolver'
import { DEFAULT_BROWSER_PROFILE_ID } from '@craft-agent/shared/config/types'

describe('getProfilePartition', () => {
  it('default profile maps to legacy partition string (zero migration)', () => {
    expect(getProfilePartition(DEFAULT_BROWSER_PROFILE_ID)).toBe('persist:browser-pane')
    expect(getProfilePartition(DEFAULT_BROWSER_PROFILE_ID)).toBe(DEFAULT_BROWSER_PROFILE_PARTITION)
  })

  it('treats undefined/null/empty as default', () => {
    expect(getProfilePartition(undefined)).toBe('persist:browser-pane')
    expect(getProfilePartition(null)).toBe('persist:browser-pane')
    expect(getProfilePartition('')).toBe('persist:browser-pane')
  })

  it('non-default profile maps to namespaced partition', () => {
    expect(getProfilePartition('abc123')).toBe('persist:browser-pane:abc123')
    expect(getProfilePartition('work')).toBe('persist:browser-pane:work')
  })
})

describe('isProfilePartition', () => {
  it('recognizes legacy partition', () => {
    expect(isProfilePartition('persist:browser-pane')).toBe(true)
  })

  it('recognizes namespaced partitions', () => {
    expect(isProfilePartition('persist:browser-pane:abc')).toBe(true)
  })

  it('rejects unrelated partitions', () => {
    expect(isProfilePartition('persist:other')).toBe(false)
    expect(isProfilePartition('')).toBe(false)
  })
})

describe('profileIdFromPartition', () => {
  it('legacy partition returns default id', () => {
    expect(profileIdFromPartition('persist:browser-pane')).toBe(DEFAULT_BROWSER_PROFILE_ID)
  })

  it('namespaced partition returns suffix', () => {
    expect(profileIdFromPartition('persist:browser-pane:work')).toBe('work')
  })

  it('unrelated partition returns null', () => {
    expect(profileIdFromPartition('persist:other')).toBeNull()
  })

  it('empty suffix returns null', () => {
    expect(profileIdFromPartition('persist:browser-pane:')).toBeNull()
  })
})
