import { describe, expect, it } from 'bun:test'
import { formatRecordingElapsed } from '../recording-elapsed'

describe('formatRecordingElapsed', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatRecordingElapsed(0)).toBe('0:00')
    expect(formatRecordingElapsed(9_000)).toBe('0:09')
    expect(formatRecordingElapsed(65_000)).toBe('1:05')
    expect(formatRecordingElapsed(599_000)).toBe('9:59')
  })

  it('formats an hour and beyond as h:mm:ss', () => {
    expect(formatRecordingElapsed(3_600_000)).toBe('1:00:00')
    expect(formatRecordingElapsed(3_725_000)).toBe('1:02:05')
  })

  it('floors sub-second remainders instead of rounding up', () => {
    // Um tick a 999ms não pode mostrar 0:01 antes de o segundo fechar.
    expect(formatRecordingElapsed(999)).toBe('0:00')
    expect(formatRecordingElapsed(59_999)).toBe('0:59')
  })

  it('clamps nonsense input to zero', () => {
    // Relógio do renderer pode andar para trás; o timer não pode virar "-1:59".
    expect(formatRecordingElapsed(-5)).toBe('0:00')
    expect(formatRecordingElapsed(Number.NaN)).toBe('0:00')
    expect(formatRecordingElapsed(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
