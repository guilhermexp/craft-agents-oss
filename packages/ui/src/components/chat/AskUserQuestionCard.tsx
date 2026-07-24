import * as React from 'react'
import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, CircleHelp, SkipForward } from 'lucide-react'
import type { AskUserQuestionItem, AskUserQuestionResponse } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { Spinner } from '../ui/LoadingIndicator'
import { m, AnimatePresence } from 'motion/react'

export interface AskUserQuestionCardProps {
  /** Questions to present (from the AskUserQuestion tool input). */
  questions: AskUserQuestionItem[]
  /** Awaiting an answer — renders interactive controls. Otherwise read-only. */
  interactive: boolean
  /** Answers already given (parsed from the tool result) for the read-only view. */
  answered?: AskUserQuestionResponse | null
  /** Fired when the user submits answers or skips. Only used when interactive. */
  onRespond?: (response: AskUserQuestionResponse) => void
}

/** Sentinel option label that reveals the free-text field. */
const OTHER_LABEL = 'Other'

/** Canonical tool name the AskUserQuestion questionnaire renders for. */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parse an AskUserQuestion tool result into the answers to show read-only.
 * Tolerates both the raw `{questions, answers, response}` shape (Pi) and a
 * `{data: {...}}` wrapper (Claude SDK). Returns null when there is nothing
 * structured to show.
 */
export function parseAskUserQuestionResult(content: string | undefined): AskUserQuestionResponse | null {
  if (!content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const root = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed
  if (!isRecord(root) || !isRecord(root.answers)) return null
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(root.answers)) {
    if (typeof value === 'string') answers[key] = value
  }
  const response = typeof root.response === 'string' ? root.response : undefined
  return { answers, response }
}

function buildAnswers(
  questions: AskUserQuestionItem[],
  selections: Record<number, string[]>,
  otherText: Record<number, string>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((q, index) => {
    const custom = otherText[index]?.trim()
    if (custom) {
      answers[q.question] = custom
      return
    }
    answers[q.question] = (selections[index] ?? []).join(', ')
  })
  return answers
}

/**
 * Inline questionnaire rendered when the agent calls AskUserQuestion.
 *
 * While parked (interactive) it works as a one-question-at-a-time carousel:
 * answering the current question reveals the next in the same block, with
 * Back/Next controls and a progress indicator. Single-select answers advance
 * automatically; multi-select and free-text answers advance via Next. Once
 * answered (read-only) it renders a compact stacked summary of every choice.
 */
export function AskUserQuestionCard({ questions, interactive, answered, onRespond }: AskUserQuestionCardProps) {
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({})
  const [step, setStep] = useState(0)
  const [submitted, setSubmitted] = useState(false)

  const total = questions.length
  const readOnly = !interactive || !onRespond || submitted
  const safeStep = Math.min(step, Math.max(total - 1, 0))
  const isLast = safeStep >= total - 1

  const isAnswered = (index: number): boolean => {
    if (otherText[index]?.trim()) return true
    return (selections[index] ?? []).length > 0
  }
  const canSubmit = questions.every((_, index) => isAnswered(index))

  const toggleOption = (index: number, label: string, multiSelect: boolean) => {
    setOtherOpen(prev => ({ ...prev, [index]: false }))
    setOtherText(prev => ({ ...prev, [index]: '' }))
    setSelections(prev => {
      const current = prev[index] ?? []
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label]
        return { ...prev, [index]: next }
      }
      return { ...prev, [index]: [label] }
    })
    // Carousel: a single-select answer reveals the next question automatically.
    if (!multiSelect && index < total - 1) {
      setStep(index + 1)
    }
  }

  const openOther = (index: number) => {
    setSelections(prev => ({ ...prev, [index]: [] }))
    setOtherOpen(prev => ({ ...prev, [index]: true }))
  }

  const handleSubmit = () => {
    if (!onRespond || !canSubmit) return
    setSubmitted(true)
    onRespond({ answers: buildAnswers(questions, selections, otherText) })
  }

  const handleSkip = () => {
    if (!onRespond) return
    setSubmitted(true)
    onRespond({ answers: {}, skipped: true })
  }

  const headerLabel = readOnly
    ? (total > 1 ? `${total} questions` : 'A question for you')
    : (total > 1 ? `Question ${safeStep + 1} of ${total}` : 'A question for you')

  // Read-only: stacked summary of every question and its chosen answer.
  if (readOnly) {
    return (
      <div className="rounded-xl border border-border bg-foreground-3 overflow-hidden text-[13px]">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border text-info">
          <CircleHelp className="size-3.5" />
          <span className="font-medium">{headerLabel}</span>
          {submitted && !answered && <Spinner className="ml-auto text-[10px]" />}
        </div>
        <div className="p-3 space-y-3">
          {questions.map((question, index) => {
            const given = answered?.answers?.[question.question]
            const local = otherText[index]?.trim() || (selections[index] ?? []).join(', ')
            const shown = given && given.length > 0 ? given : local
            return (
              <div key={index} className="space-y-0.5">
                {question.header && (
                  <span className="inline-block rounded bg-foreground-10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                )}
                <p className="font-medium text-foreground">{question.question}</p>
                <p className="text-muted-foreground">
                  {shown && shown.length > 0 ? shown : answered?.skipped ? 'Skipped' : 'Awaiting answer…'}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Interactive: one question at a time.
  const question = questions[safeStep]!
  const selected = selections[safeStep] ?? []
  const otherIsOpen = otherOpen[safeStep] ?? false
  const currentAnswered = isAnswered(safeStep)

  return (
    <div className="rounded-xl border border-border bg-foreground-3 overflow-hidden text-[13px]">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border text-info">
        <CircleHelp className="size-3.5" />
        <span className="font-medium">{headerLabel}</span>
        {total > 1 && (
          <div className="ml-auto flex items-center gap-1">
            {questions.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'size-1.5 rounded-full transition-colors',
                  i === safeStep ? 'bg-info' : isAnswered(i) ? 'bg-info/40' : 'bg-foreground-20',
                )}
              />
            ))}
          </div>
        )}
      </div>

      <div className="p-3">
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={safeStep}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="space-y-1.5"
          >
            {question.header && (
              <span className="inline-block rounded bg-foreground-10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            )}
            <p className="font-medium text-foreground">{question.question}</p>
            <div className="space-y-1">
              {question.options.map((option, oIndex) => {
                const isSelected = selected.includes(option.label)
                return (
                  <button
                    key={oIndex}
                    type="button"
                    onClick={() => toggleOption(safeStep, option.label, !!question.multiSelect)}
                    className={cn(
                      'w-full flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                      isSelected ? 'border-accent bg-accent/10' : 'border-border hover:bg-foreground-5',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-3.5 shrink-0 items-center justify-center border',
                        question.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        isSelected ? 'border-accent bg-accent text-white' : 'border-foreground-30',
                      )}
                    >
                      {isSelected && <Check className="size-2.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-foreground">{option.label}</span>
                      {option.description && (
                        <span className="block text-[11px] text-muted-foreground">{option.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}

              {otherIsOpen ? (
                <input
                  autoFocus
                  type="text"
                  value={otherText[safeStep] ?? ''}
                  onChange={e => setOtherText(prev => ({ ...prev, [safeStep]: e.target.value }))}
                  placeholder="Type your own answer…"
                  className="w-full rounded-lg border border-accent bg-background px-2.5 py-1.5 text-foreground outline-none placeholder:text-muted-foreground"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => openOther(safeStep)}
                  className="w-full rounded-lg border border-dashed border-border px-2.5 py-1.5 text-left text-muted-foreground hover:bg-foreground-5"
                >
                  {OTHER_LABEL}…
                </button>
              )}
            </div>
          </m.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={handleSkip}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-muted-foreground hover:bg-foreground-5 hover:text-foreground"
        >
          <SkipForward className="size-3" />
          Skip
        </button>
        <div className="ml-auto flex items-center gap-2">
          {total > 1 && safeStep > 0 && (
            <button
              type="button"
              onClick={() => setStep(safeStep - 1)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-muted-foreground hover:bg-foreground-5 hover:text-foreground"
            >
              <ChevronLeft className="size-3" />
              Back
            </button>
          )}
          {isLast ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition-opacity',
                canSubmit ? 'bg-accent text-white hover:opacity-90' : 'bg-foreground-10 text-muted-foreground cursor-not-allowed',
              )}
            >
              <Check className="size-3" />
              Submit
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep(Math.min(safeStep + 1, total - 1))}
              disabled={!currentAnswered}
              className={cn(
                'flex items-center gap-1 rounded-lg px-3 py-1 font-medium transition-opacity',
                currentAnswered ? 'bg-accent text-white hover:opacity-90' : 'bg-foreground-10 text-muted-foreground cursor-not-allowed',
              )}
            >
              Next
              <ChevronRight className="size-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
