export interface MessagingSupergroupSnapshot {
  chatId: string
  capturedAt: number
}

/** A pre-existing binding is not a successful pairing for a newly opened dialog. */
export function isNewSupergroupPairing(
  baseline: MessagingSupergroupSnapshot | null,
  current: MessagingSupergroupSnapshot | null,
): boolean {
  if (!current) return false
  return !baseline
    || current.chatId !== baseline.chatId
    || current.capturedAt !== baseline.capturedAt
}
