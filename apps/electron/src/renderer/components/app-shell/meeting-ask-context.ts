/**
 * Meeting Q&A context
 *
 * Builds the hidden context injected into the mini-agent popover for a single
 * meeting: who the agent is, which meeting this is, and the transcript as it
 * stands.
 *
 * A live meeting is the interesting case. Its transcript is a snapshot that
 * grows, and its summary does not exist yet, so the agent has to be told that
 * silence means "not said yet" rather than "not in the meeting" — otherwise it
 * answers a question about an ongoing call as if the call were over.
 */

import type { EditContext } from '@/components/ui/EditPopover'

export interface MeetingAskContextInput {
  title: string
  url?: string
  summaryMarkdown?: string
  /** `null` while the first fetch is still in flight, `''` when unavailable. */
  transcriptText: string | null
  loading: boolean
  /** The call is still running, so the transcript is partial by definition. */
  live: boolean
}

export function buildMeetingAskContext(input: MeetingAskContextInput): EditContext {
  const transcriptBlock =
    input.transcriptText && input.transcriptText.length > 0
      ? input.transcriptText
      : input.loading
        ? '(loading transcript…)'
        : input.live
          ? '(nothing transcribed yet)'
          : '(transcript unavailable)'

  const body = [
    'You are a meeting assistant. Do NOT edit, create, or validate any files or configuration. ' +
      'Answer the user\'s questions about the meeting below using ONLY the summary and transcript provided. ' +
      'Be concise, reference speakers when relevant, and reply in the language of the transcript. ' +
      'If the transcript does not contain the answer, say so plainly instead of guessing.',
    '',
    `Meeting: ${input.title}`,
    input.url ? `URL: ${input.url}` : '',
    input.live
      ? 'Status: this meeting is happening right now. The transcript below is only what has been said so far, so anything missing may simply not have been said yet.'
      : '',
    input.summaryMarkdown ? `\nSummary:\n${input.summaryMarkdown}` : '',
    `\nTranscript:\n${transcriptBlock}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    label: 'Meeting Q&A',
    filePath: '',
    context: body,
  }
}
