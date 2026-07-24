/**
 * Pure decision helpers for context-overflow recovery.
 *
 * Extracted from index.ts so the recovery state machine can be unit-tested
 * without spawning the stdio subprocess. index.ts owns the mutable flags,
 * event subscription, and `send()`; these functions only classify strings and
 * events.
 */

/**
 * True when a provider/SDK error message indicates the model context window
 * was exceeded. Used to decide whether to run compact+retry recovery.
 */
export function isContextOverflowErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('context_length_exceeded') ||
    normalized.includes('exceeds the context window') ||
    (normalized.includes('context window') && normalized.includes('exceed')) ||
    normalized.includes('too many tokens') ||
    normalized.includes('token limit exceeded')
  );
}

/**
 * True when a `session.compact()` failure is the benign "there was nothing new
 * to compact" race — the SDK's own auto-compaction (enabled at spawn) already
 * ran, or the context is too small to compact. Callers treat this as a
 * success no-op instead of surfacing the raw plumbing error.
 */
export function isAlreadyCompactedMessage(message: string): boolean {
  return /already compacted|nothing to compact/i.test(message);
}

/** Minimal shape of the SDK session events the suppressor inspects. */
export interface OverflowSuppressionEvent {
  type?: string;
  errorMessage?: unknown;
  result?: unknown;
  message?: { role?: string; stopReason?: string } | unknown;
}

export interface OverflowRecoveryState {
  /** A compact+retry is in flight (spans manual compact and the retry turn). */
  inProgress: boolean;
  /** The retry prompt is streaming (a re-overflow here is the terminal case). */
  retryPhase: boolean;
}

export type OverflowSuppressionDecision =
  | { action: 'forward' }
  | { action: 'suppress'; terminal: boolean };

/**
 * Decide whether an SDK event should be dropped while an overflow recovery is
 * running, and whether dropping it should surface the single terminal error.
 *
 * A retry that overflows again would otherwise emit three stacked errors — a
 * `compaction_end` failure, the raw provider error, and the wrapper's own
 * recovery-failed error. This collapses the noisy plumbing:
 *
 * - `compaction_end` with an error and no result: always suppressed while
 *   recovering. It is terminal only during the retry phase; during the manual
 *   compact phase the "already compacted" race is handled by the caller's
 *   try/catch, so we stay quiet and let recovery proceed.
 * - assistant `message_end` with `stopReason: 'error'` during the retry phase:
 *   the raw re-overflow / bad-request provider error. Suppressed but NOT
 *   terminal — the SDK's own auto-compaction may still recover and answer on
 *   the same turn. Recovery is only declared exhausted by a `compaction_end`
 *   failure (double-overflow guard) or by `session.prompt` throwing (caller's
 *   catch), so we drop the noise here and wait for one of those.
 *
 * Everything else (successful compactions, successful assistant messages,
 * `agent_end`) forwards normally so the turn still completes.
 */
export function decideOverflowSuppression(
  event: OverflowSuppressionEvent,
  state: OverflowRecoveryState,
): OverflowSuppressionDecision {
  if (!state.inProgress) return { action: 'forward' };

  if (event.type === 'compaction_end') {
    const errorMessage = typeof event.errorMessage === 'string' ? event.errorMessage : undefined;
    if (errorMessage && !event.result) {
      return { action: 'suppress', terminal: state.retryPhase };
    }
  }

  if (state.retryPhase && event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string } | undefined;
    if (msg?.role === 'assistant' && msg.stopReason === 'error') {
      return { action: 'suppress', terminal: false };
    }
  }

  return { action: 'forward' };
}
