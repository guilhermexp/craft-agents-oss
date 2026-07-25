import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_BROWSER_PROFILE_ID,
  normalizeBrowserProfile,
  normalizeBrowserProfileSettings,
  sanitizeBrowserProfileInput,
  suggestBrowserProfileIdForUrl,
  type BrowserProfileInput,
} from '../browser-profiles'

const now = () => 1234567890

describe('browser profile normalization', () => {
  it('seeds and preserves the default profile as a personal isolated account context', () => {
    const settings = normalizeBrowserProfileSettings({ profiles: [], lastUsedProfileId: 'missing', alwaysAsk: false }, now)

    expect(settings.profiles[0]).toMatchObject({
      id: DEFAULT_BROWSER_PROFILE_ID,
      name: 'Default',
      kind: 'personal',
      color: '#22c55e',
      createdAt: now(),
    })
    expect(settings.lastUsedProfileId).toBe(DEFAULT_BROWSER_PROFILE_ID)
  })

  it('sanitizes user-created profile metadata without leaking arbitrary malformed values', () => {
    const input = sanitizeBrowserProfileInput({
      name: '  Cliente ACME  ',
      color: 'not-a-color',
      kind: 'client',
      clientName: '  ACME Ltda  ',
      description: '  Conta admin do cliente  ',
      domainHints: [' https://admin.acme.com/login ', 'ACME.com', 'bad host with spaces', '', 'admin.acme.com'],
    })

    expect(input).toEqual({
      name: 'Cliente ACME',
      color: '#22c55e',
      kind: 'client',
      clientName: 'ACME Ltda',
      description: 'Conta admin do cliente',
      domainHints: ['admin.acme.com', 'acme.com'],
    })
  })

  it('normalizes legacy profiles by adding kind and cleaned domain hints', () => {
    const profile = normalizeBrowserProfile({
      id: 'client-x',
      name: ' Cliente X ',
      color: '#3B82F6',
      createdAt: 10,
      kind: 'invalid',
      domainHints: ['https://cliente.test/admin', 'cliente.test'],
    } as any, now)

    expect(profile).toMatchObject({
      id: 'client-x',
      name: 'Cliente X',
      color: '#3B82F6',
      kind: 'personal',
      domainHints: ['cliente.test'],
      createdAt: 10,
    })
  })

  it('preserves userOnly through sanitize, profile normalization, and settings normalization', () => {
    const sanitized = sanitizeBrowserProfileInput({
      name: 'Connected account',
      userOnly: true,
    })
    const profile = normalizeBrowserProfile({
      id: 'connected',
      ...sanitized,
      createdAt: 10,
    }, now)
    const settings = normalizeBrowserProfileSettings({
      profiles: [profile],
      lastUsedProfileId: 'connected',
      alwaysAsk: false,
    }, now)

    expect(sanitized.userOnly).toBe(true)
    expect(profile.userOnly).toBe(true)
    expect(settings.profiles.find(candidate => candidate.id === 'connected')?.userOnly).toBe(true)
  })

  it('keeps an absent userOnly capability undefined', () => {
    const sanitized = sanitizeBrowserProfileInput({ name: 'Regular profile' })
    const profile = normalizeBrowserProfile({
      id: 'regular',
      ...sanitized,
      createdAt: 10,
    }, now)

    expect(sanitized.userOnly).toBeUndefined()
    expect(profile.userOnly).toBeUndefined()
  })

  it('does not persist a non-boolean userOnly value', () => {
    const malformed = {
      name: 'Malformed profile',
      userOnly: 'true',
    } as unknown as BrowserProfileInput

    const sanitized = sanitizeBrowserProfileInput(malformed)
    const profile = normalizeBrowserProfile({
      id: 'malformed',
      ...sanitized,
      createdAt: 10,
    }, now)

    expect(sanitized.userOnly).toBeUndefined()
    expect(profile.userOnly).toBeUndefined()
  })
})

describe('browser profile domain suggestions', () => {
  it('suggests the most specific profile hint for a URL hostname', () => {
    const settings = normalizeBrowserProfileSettings({
      profiles: [
        { id: DEFAULT_BROWSER_PROFILE_ID, name: 'Default', color: '#22c55e', createdAt: 1 },
        { id: 'client', name: 'Cliente', color: '#3b82f6', createdAt: 1, kind: 'client', domainHints: ['cliente.com'] },
        { id: 'admin', name: 'Admin Cliente', color: '#f97316', createdAt: 1, kind: 'client', domainHints: ['admin.cliente.com'] },
      ],
      lastUsedProfileId: DEFAULT_BROWSER_PROFILE_ID,
      alwaysAsk: false,
    }, now)

    expect(suggestBrowserProfileIdForUrl('https://admin.cliente.com/login', settings)).toBe('admin')
    expect(suggestBrowserProfileIdForUrl('https://app.cliente.com', settings)).toBe('client')
    expect(suggestBrowserProfileIdForUrl('notaurl', settings)).toBeNull()
  })
})
