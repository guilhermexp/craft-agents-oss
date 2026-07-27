import { describe, expect, it } from 'bun:test'
import { parseAskUserQuestionResult } from '../AskUserQuestionCard'

describe('parseAskUserQuestionResult', () => {
  it('preserves an explicit skipped flag', () => {
    expect(parseAskUserQuestionResult(JSON.stringify({
      answers: {},
      skipped: true,
    }))).toEqual({
      answers: {},
      response: undefined,
      skipped: true,
    })
  })

  it('infers skipped for historical results with no answers and no flag', () => {
    expect(parseAskUserQuestionResult(JSON.stringify({
      answers: {},
    }))).toEqual({
      answers: {},
      response: undefined,
      skipped: true,
    })
  })

  it('keeps a normal answered result unskipped', () => {
    expect(parseAskUserQuestionResult(JSON.stringify({
      answers: { 'Pick one?': 'A' },
      response: 'A',
    }))).toEqual({
      answers: { 'Pick one?': 'A' },
      response: 'A',
    })
  })
})
