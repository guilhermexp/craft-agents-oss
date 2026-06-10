/**
 * MeetingAskButton
 *
 * "Ask about this meeting" trigger that opens the inline mini-agent popover
 * (same EditPopover/ChatDisplay surface used for skill/config edits) scoped to a
 * single meeting. The transcript is fetched lazily when the popover opens and
 * injected as hidden context so the user can ask follow-up questions.
 *
 * Runtime rule: model 'fast' resolves to the configured connection's mini model
 * (Claude -> haiku, Pi -> gpt-mini), matching the post-meeting summary path.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EditPopover, type EditContext } from '@/components/ui/EditPopover'
import type { MeetingRecord, MeetingTranscriptResult } from '../../../shared/types'

function buildTranscriptText(segments: MeetingTranscriptResult['transcript']): string {
  return segments
    .map((segment) => `${segment.speaker?.trim() || 'Speaker'}: ${segment.text}`)
    .join('\n')
}

interface MeetingAskButtonProps {
  workspaceId: string
  record: MeetingRecord
}

export function MeetingAskButton({ workspaceId, record }: MeetingAskButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // null = not fetched yet, '' = fetched but empty/unavailable
  const [transcriptText, setTranscriptText] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  // Lazily load the transcript the first time the popover opens.
  React.useEffect(() => {
    if (!open || transcriptText !== null) return
    let cancelled = false
    setLoading(true)
    void window.electronAPI.meetings
      .transcript(workspaceId, record.id)
      .then((res) => {
        if (!cancelled) setTranscriptText(buildTranscriptText(res.transcript ?? []))
      })
      .catch(() => {
        if (!cancelled) setTranscriptText('')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, transcriptText, workspaceId, record.id])

  const title = record.title || record.code || 'Google Meet'

  const context: EditContext = React.useMemo(() => {
    const transcriptBlock =
      transcriptText && transcriptText.length > 0
        ? transcriptText
        : loading
          ? '(loading transcript…)'
          : '(transcript unavailable)'

    const body = [
      'You are a meeting assistant. Do NOT edit, create, or validate any files or configuration. ' +
        'Answer the user\'s questions about the meeting below using ONLY the summary and transcript provided. ' +
        'Be concise, reference speakers when relevant, and reply in the language of the transcript. ' +
        'If the transcript does not contain the answer, say so plainly instead of guessing.',
      '',
      `Meeting: ${title}`,
      record.url ? `URL: ${record.url}` : '',
      record.summaryMarkdown ? `\nSummary:\n${record.summaryMarkdown}` : '',
      `\nTranscript:\n${transcriptBlock}`,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      label: 'Meeting Q&A',
      filePath: '',
      context: body,
    }
  }, [title, record.url, record.summaryMarkdown, transcriptText, loading])

  // The popover content renders through a Radix portal, but React events bubble
  // through the React tree — not the DOM — so keystrokes inside the popover reach
  // the parent meeting row's onClick/onKeyDown (which preventDefault Space/Enter and
  // re-select the meeting). Stop propagation here so the row never sees them.
  const stopBubbling = React.useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  return (
    <span
      style={{ display: 'contents' }}
      onClick={stopBubbling}
      onKeyDown={stopBubbling}
      onKeyUp={stopBubbling}
    >
      <EditPopover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs opacity-90"
          >
            <MessageCircle className="size-3" />
            {t('meetings.ask', 'Perguntar')}
          </Button>
        }
        context={context}
        displayLabel={title}
        model="fast"
        systemPromptPreset="mini"
        permissionMode="allow-all"
        workingDirectory="none"
        inlineExecution
        side="bottom"
        align="end"
      />
    </span>
  )
}
