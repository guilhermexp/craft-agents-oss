import { describe, expect, it } from 'bun:test'
import { isRenderableQuestion } from '../turn-card-question'
import type { ActivityItem } from '../turn-card-shared'

function questionActivity(questions: unknown): ActivityItem {
  return {
    id: 'question-tool',
    type: 'tool',
    status: 'running',
    toolName: 'AskUserQuestion',
    toolInput: { questions },
    timestamp: Date.now(),
  }
}

describe('isRenderableQuestion', () => {
  it('rejects a question without options', () => {
    expect(isRenderableQuestion(questionActivity([{ question: 'Pick one?' }]))).toBe(false)
  })

  it('rejects a question with no options', () => {
    expect(isRenderableQuestion(questionActivity([{ question: 'Pick one?', options: [] }]))).toBe(false)
  })

  it('rejects an option without a label', () => {
    expect(isRenderableQuestion(questionActivity([
      { question: 'Pick one?', options: [{ description: 'Missing label' }] },
    ]))).toBe(false)
  })

  it('accepts a well-formed questionnaire', () => {
    expect(isRenderableQuestion(questionActivity([
      { question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] },
    ]))).toBe(true)
  })
})
