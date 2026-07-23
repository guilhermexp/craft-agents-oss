import { describe, expect, it } from 'bun:test'
import { normalizeChromeClientHints } from '../browser-client-hints'

describe('normalizeChromeClientHints', () => {
  it('injects a Google Chrome brand version-matched to Chromium', () => {
    const out = normalizeChromeClientHints({
      'Sec-CH-UA': '"Chromium";v="140", "Not=A?Brand";v="24"',
    })
    expect(out['Sec-CH-UA']).toBe('"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"')
  })

  it('drops the Electron brand and keeps the greased brand', () => {
    const out = normalizeChromeClientHints({
      'sec-ch-ua': '"Chromium";v="140", "Electron";v="43", "Not=A?Brand";v="24"',
    })
    expect(out['sec-ch-ua']).toBe('"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"')
  })

  it('normalizes the high-entropy full version list too', () => {
    const out = normalizeChromeClientHints({
      'Sec-CH-UA': '"Chromium";v="140", "Not=A?Brand";v="24"',
      'Sec-CH-UA-Full-Version-List':
        '"Chromium";v="140.0.7339.5", "Electron";v="43.1.1", "Not=A?Brand";v="24.0.0.0"',
    })
    expect(out['Sec-CH-UA-Full-Version-List']).toBe(
      '"Chromium";v="140.0.7339.5", "Google Chrome";v="140.0.7339.5", "Not=A?Brand";v="24.0.0.0"',
    )
  })

  it('does not duplicate an existing Google Chrome brand', () => {
    const value = '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"'
    const out = normalizeChromeClientHints({ 'Sec-CH-UA': value })
    expect(out['Sec-CH-UA']).toBe(value)
  })

  it('leaves requests without Sec-CH-UA untouched (same reference)', () => {
    const headers = { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' }
    expect(normalizeChromeClientHints(headers)).toBe(headers)
  })

  it('preserves unrelated headers', () => {
    const out = normalizeChromeClientHints({
      Accept: 'text/html',
      'Sec-CH-UA': '"Chromium";v="140", "Not=A?Brand";v="24"',
      'Sec-CH-UA-Platform': '"macOS"',
    })
    expect(out['Accept']).toBe('text/html')
    expect(out['Sec-CH-UA-Platform']).toBe('"macOS"')
  })
})
