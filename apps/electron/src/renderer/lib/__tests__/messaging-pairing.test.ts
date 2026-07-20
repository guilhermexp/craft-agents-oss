import { describe, expect, it } from 'bun:test'
import { isNewSupergroupPairing } from '../messaging-pairing'

describe('isNewSupergroupPairing', () => {
  it('ignores the binding that already existed when the dialog opened', () => {
    const existing = { chatId: 'group-1', capturedAt: 100 }
    expect(isNewSupergroupPairing(existing, existing)).toBe(false)
  })

  it('accepts a newly captured binding', () => {
    expect(isNewSupergroupPairing(null, { chatId: 'group-1', capturedAt: 100 })).toBe(true)
    expect(isNewSupergroupPairing(
      { chatId: 'group-1', capturedAt: 100 },
      { chatId: 'group-1', capturedAt: 200 },
    )).toBe(true)
  })
})
