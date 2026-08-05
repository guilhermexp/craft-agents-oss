/**
 * MeetingAskButton
 *
 * "Ask about this meeting" trigger that opens the inline mini-agent popover
 * (same EditPopover/ChatDisplay surface used for skill/config edits) scoped to a
 * single meeting. The transcript is fetched when the popover opens — every open,
 * because a live call's transcript grows — and injected as hidden context
 * (`meeting-ask-context.ts`) so the user can ask follow-up questions. The same
 * button serves the meeting list and the call hosted by the Meetings page.
 *
 * Runtime rule: model 'fast' resolves to the configured connection's mini model
 * (Claude -> haiku, Pi -> gpt-mini), matching the post-meeting summary path.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EditPopover } from '@/components/ui/EditPopover'
import { buildMeetingAskContext } from './meeting-ask-context'
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

  // Load the transcript every time the popover opens. A live meeting's
  // transcript grows while the call runs, so a value cached from an earlier open
  // would answer about a stale call. The previous text stays in place until the
  // new one lands, so reopening never falls back to "(loading…)".
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void window.electronAPI.meetings
      .transcript(workspaceId, record.id)
      .then((res) => {
        if (!cancelled) setTranscriptText(buildTranscriptText(res.transcript ?? []))
      })
      .catch(() => {
        // A failed refetch must not erase a transcript an earlier open did get.
        if (!cancelled) setTranscriptText((current) => current ?? '')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, workspaceId, record.id])

  const title = record.title || record.code || 'Google Meet'
  const displayLabel = t('meetings.askAbout', { title })
  const placeholder = t('meetings.askPlaceholder')

  const context = React.useMemo(() => buildMeetingAskContext({
    title,
    url: record.url,
    summaryMarkdown: record.summaryMarkdown,
    transcriptText,
    loading,
    live: record.status === 'starting' || record.status === 'running',
  }), [title, record.url, record.summaryMarkdown, record.status, transcriptText, loading])

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
            {t('meetings.ask')}
          </Button>
        }
        context={context}
        displayLabel={displayLabel}
        overridePlaceholder={placeholder}
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
