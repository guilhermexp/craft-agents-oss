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
