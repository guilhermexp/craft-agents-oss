/**
 * MeetingSummaryService
 *
 * Generates the post-meeting summary by running the workspace's CONFIGURED
 * Craft agent (Claude / Pi) on the ready transcript — one-shot, via
 * AgentBackend.queryLlm. Mirrors the skill-edit pattern (run the configured
 * agent on a task), but headless from the main process.
 *
 * Runtime separation: Hermes is intentionally EXCLUDED here. Hermes is a
 * self-contained backend with its own skills and its own Google Meet plugin
 * (see meeting-service.runHermesMeetPlugin). Craft-native recordings
 * (captureMode 'craft') must use a Craft agent, never reach into Hermes.
 *
 * Transcription (audio → text) stays with the STT provider (Deepgram). The
 * agent only does the text → markdown summary/follow-up step.
 */

import { mainLog } from '../logger'
import { getLlmConnections, getDefaultLlmConnection, getLlmConnection } from '@craft-agent/shared/config'
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend'
import { loadSkill } from '@craft-agent/shared/skills'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { MeetingRecord, MeetingTranscriptSegment } from '../../shared/types'

/** Workspace skill that, when present, overrides the default summary instructions. */
const MEETING_NOTES_SKILL_SLUG = 'meeting-notes'
const SUMMARY_MAX_TOKENS = 2_000
/** Mirror of the shared LLM_QUERY_TIMEOUT_MS — caps a hung backend for the best-effort summary. */
const SUMMARY_QUERY_TIMEOUT_MS = 120_000

const DEFAULT_SUMMARY_INSTRUCTIONS = `You are a meeting note-taker. Produce concise, well-structured Markdown notes from the meeting transcript provided.

Include, when the transcript supports it:
- A short one-paragraph overview
- Key discussion points (bullets)
- Decisions made
- Action items, with owners and due dates if mentioned

Write in the same language as the transcript. Output ONLY the Markdown notes — no preamble, no code fences around the whole document.`

const FOLLOW_UP_INSTRUCTIONS = `Also include a follow-up section when the transcript supports it. Extract concrete next steps, owners, and due dates. If no owner or due date is mentioned, say so briefly instead of inventing one.`

export interface MeetingSummaryInput {
  workspaceId: string
  workspaceRootPath: string
  record: MeetingRecord
  segments: MeetingTranscriptSegment[]
}

/**
 * Resolve which LLM connection runs the summary. Prefers the configured
 * default, but only when it is NOT Hermes; otherwise the first non-Hermes
 * connection. Returns null when only Hermes is configured — in that case we
 * skip the Craft-native summary rather than route into Hermes.
 */
function resolveCraftConnectionSlug(): string | null {
  const defaultSlug = getDefaultLlmConnection()
  if (defaultSlug) {
    const def = getLlmConnection(defaultSlug)
    if (def && def.providerType !== 'hermes') return def.slug
  }
  const craft = getLlmConnections().find((c) => c.providerType !== 'hermes')
  return craft?.slug ?? null
}

function buildTranscriptText(segments: MeetingTranscriptSegment[]): string {
  return segments
    .map((segment) => `${segment.speaker?.trim() || 'Speaker'}: ${segment.text}`)
    .join('\n')
}

/**
 * Run the configured Craft agent on the transcript and return summary Markdown.
 * Returns null (and logs) when there is no transcript, no eligible connection,
 * or the query fails — callers keep the existing boilerplate summary in that case.
 */
export async function generateMeetingSummaryMarkdown(input: MeetingSummaryInput): Promise<string | null> {
  const { workspaceId, workspaceRootPath, record, segments } = input
  if (segments.length === 0) return null

  const connectionSlug = resolveCraftConnectionSlug()
  if (!connectionSlug) {
    mainLog.warn('[meetings] no non-Hermes LLM connection configured; skipping agent summary')
    return null
  }

  const skill = loadSkill(workspaceRootPath, MEETING_NOTES_SKILL_SLUG)
  const baseSystemPrompt = skill?.content?.trim() || DEFAULT_SUMMARY_INSTRUCTIONS
  const systemPrompt = record.followUpOnEnd
    ? `${baseSystemPrompt}\n\n${FOLLOW_UP_INSTRUCTIONS}`
    : baseSystemPrompt

  const prompt = [
    `Meeting title: ${record.title || 'Untitled meeting'}`,
    record.url ? `URL: ${record.url}` : '',
    '',
    'Transcript:',
    buildTranscriptText(segments),
  ]
    .filter(Boolean)
    .join('\n')

  let backend: AgentBackend | undefined
  try {
    backend = createBackendFromConnection(connectionSlug, {
      workspace: {
        id: workspaceId,
        name: `Workspace ${workspaceId}`,
        slug: workspaceId,
        rootPath: workspaceRootPath,
        createdAt: 0,
      },
      isHeadless: true,
    })
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      backend.queryLlm({
        prompt,
        systemPrompt,
        maxTokens: SUMMARY_MAX_TOKENS,
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`summary queryLlm timed out after ${SUMMARY_QUERY_TIMEOUT_MS}ms`)),
          SUMMARY_QUERY_TIMEOUT_MS,
        )
      }),
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    })
    const text = result.text?.trim()
    if (!text) {
      mainLog.warn(`[meetings] agent summary returned empty text (connection=${connectionSlug})`)
      return null
    }
    return text
  } catch (error) {
    mainLog.error(
      `[meetings] agent summary failed (connection=${connectionSlug}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  } finally {
    try {
      backend?.destroy()
    } catch {
      // best-effort teardown
    }
  }
}
