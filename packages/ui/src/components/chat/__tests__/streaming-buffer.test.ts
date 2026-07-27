/**
 * Unit tests for the streaming buffer decision logic.
 *
 * Verifies shouldShowContent() gates streaming text until it looks like
 * meaningful commentary, and isResponseBuffering() reports the withheld state.
 * Thresholds are derived from BUFFER_CONFIG so the tests track the config.
 */

import { describe, it, expect } from 'bun:test'
import { shouldShowContent, isResponseBuffering, BUFFER_CONFIG } from '../streaming-buffer'
import type { ResponseContent } from '../turn-card-shared'

/** Build a space-joined string of `count` plain words. */
const words = (count: number): string => Array.from({ length: count }, (_, i) => `w${i}`).join(' ')

describe('shouldShowContent', () => {
  it('shows non-streaming text immediately with reason complete', () => {
    const result = shouldShowContent('anything at all', false)
    expect(result.shouldShow).toBe(true)
    expect(result.reason).toBe('complete')
  })

  it('withholds streaming content under MIN_BUFFER_MS with reason min_time', () => {
    const result = shouldShowContent(words(BUFFER_CONFIG.HIGH_WORD_COUNT), true, Date.now())
    expect(result.shouldShow).toBe(false)
    expect(result.reason).toBe('min_time')
  })

  it('shows a fenced code block early once past MIN_BUFFER_MS with reason code_block', () => {
    const text = '```ts\n' + words(BUFFER_CONFIG.MIN_WORDS_CODE) + '\n```'
    const start = Date.now() - (BUFFER_CONFIG.MIN_BUFFER_MS + 50)
    const result = shouldShowContent(text, true, start)
    expect(result.shouldShow).toBe(true)
    expect(result.reason).toBe('code_block')
    expect(result.wordCount).toBeGreaterThanOrEqual(BUFFER_CONFIG.MIN_WORDS_CODE)
  })

  it('shows high plain word count with reason high_word_count', () => {
    // Plain words, no structure, past min buffer but under max buffer.
    const start = Date.now() - (BUFFER_CONFIG.MIN_BUFFER_MS + 50)
    const result = shouldShowContent(words(BUFFER_CONFIG.HIGH_WORD_COUNT), true, start)
    expect(result.shouldShow).toBe(true)
    expect(result.reason).toBe('high_word_count')
  })

  it('shows on timeout when elapsed exceeds MAX_BUFFER_MS with enough words', () => {
    const start = Date.now() - (BUFFER_CONFIG.MAX_BUFFER_MS + 100)
    const result = shouldShowContent(words(BUFFER_CONFIG.TIMEOUT_MIN_WORDS), true, start)
    expect(result.shouldShow).toBe(true)
    expect(result.reason).toBe('timeout')
  })

  it('keeps buffering short unstructured streaming text past min buffer', () => {
    const start = Date.now() - (BUFFER_CONFIG.MIN_BUFFER_MS + 50)
    const result = shouldShowContent(words(3), true, start)
    expect(result.shouldShow).toBe(false)
    expect(result.reason).toBe('buffering')
  })
})

describe('isResponseBuffering', () => {
  it('is false for an undefined response', () => {
    expect(isResponseBuffering(undefined)).toBe(false)
  })

  it('is false for a non-streaming response', () => {
    const response: ResponseContent = { text: 'done', isStreaming: false }
    expect(isResponseBuffering(response)).toBe(false)
  })

  it('is true for a streaming short response under MIN_BUFFER_MS', () => {
    const response: ResponseContent = {
      text: words(3),
      isStreaming: true,
      streamStartTime: Date.now(),
    }
    expect(isResponseBuffering(response)).toBe(true)
  })
})
