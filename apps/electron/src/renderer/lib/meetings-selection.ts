import type { MeetingRecord } from '../../shared/types'

export function shouldClearSelectedMeeting(
  records: Pick<MeetingRecord, 'id'>[],
  selectedMeetingId?: string | null,
): boolean {
  if (!selectedMeetingId) return false
  return !records.some((record) => record.id === selectedMeetingId)
}

export function isMissingMeetingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.startsWith('Meeting not found:')
}

export function resolveEffectiveMeetingId(input: {
  selectedMeetingId?: string | null
  liveStartedId?: string | null
  missingMeetingId?: string | null
}): string | null {
  const requestedMeetingId = input.selectedMeetingId ?? input.liveStartedId ?? null
  if (!requestedMeetingId) return null
  return requestedMeetingId === input.missingMeetingId ? null : requestedMeetingId
}

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/
const COMPACT_MEET_CODE_RE = /^[a-z]{10}$/

export function normalizeGoogleMeetInput(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname.toLowerCase() !== 'meet.google.com') return null
      const first = url.pathname.split('/').filter(Boolean)[0] ?? ''
      return normalizeMeetCode(first)
    } catch {
      return null
    }
  }
  return normalizeMeetCode(raw.replace(/^meet\.google\.com\//i, ''))
}

function normalizeMeetCode(value: string): string | null {
  const cleaned = value.trim().toLowerCase()
  if (MEET_CODE_RE.test(cleaned)) return `https://meet.google.com/${cleaned}`
  const compact = cleaned.replace(/[^a-z]/g, '')
  if (!COMPACT_MEET_CODE_RE.test(compact)) return null
  return `https://meet.google.com/${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7)}`
}
