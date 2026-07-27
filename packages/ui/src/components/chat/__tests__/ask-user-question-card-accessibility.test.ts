import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source-text guard because packages/ui has no RTL/jsdom harness. This protects
// the custom-answer field from regressing to placeholder-only labeling and
// ensures each rendered card/question receives a distinct associated ID.
const source = readFileSync(join(__dirname, '../AskUserQuestionCard.tsx'), 'utf8')

describe('AskUserQuestionCard custom answer accessibility', () => {
  it('associates a persistent visible label with a question-scoped input ID', () => {
    expect(source).toContain('const customAnswerIdPrefix = React.useId()')
    expect(source).toContain('const customAnswerId = `${customAnswerIdPrefix}-${safeStep}`')
    expect(source).toContain('htmlFor={customAnswerId}')
    expect(source).toContain('id={customAnswerId}')
    expect(source).toContain('Other answer')
  })

  it('exposes single and multi-select options with checked-state semantics', () => {
    expect(source).toContain("role={question.multiSelect ? 'group' : 'radiogroup'}")
    expect(source).toContain("role={question.multiSelect ? 'checkbox' : 'radio'}")
    expect(source).toContain('aria-checked={isSelected}')
  })
})
