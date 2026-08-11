/**
 * Context-usage badge derivation.
 *
 * The badge answers one question: how full is the model's context window right
 * now. It is a plain share of the window — the same number the Claude Agent SDK
 * reports as `getContextUsage().percentage` — so what the user reads matches what
 * the backend budgets against.
 *
 * Three things this must never do again:
 *  - Divide by a guessed fraction of the window. The SDK reserves a flat ~33k
 *    tokens before auto-compacting (200k → 167k, 1M → 967k), so a fixed 77.5 %
 *    threshold is wrong at both ends of the range.
 *  - Saturate below full. The old `Math.min(99, …)` clamped at a value the honest
 *    calculation can never reach, so every over-budget denominator read as a
 *    plausible "99 %" instead of showing something was wrong. Saturating at 100
 *    is safe because the hover readout always spells out the raw token counts
 *    behind it, so a bad window is visible rather than absorbed.
 *  - Trust a window the token count contradicts. `used > window` is not a full
 *    session, it is a wrong window.
 */

/** Live context signals reported by the agent backend for the current session. */
export interface ContextUsageInput {
  /** Tokens sent on the most recent request (input + cache read + cache creation). */
  usedTokens: number | undefined
  /** Window reported by the backend for the session's model, in tokens. */
  reportedContextWindow: number | undefined
  /** Registry window for the selected model, used until the backend reports one. */
  fallbackContextWindow: number | undefined
  /** True while the backend is compacting the conversation. */
  isCompacting: boolean
  /** True while a turn is in flight. */
  isProcessing: boolean
}

/** Visual weight of the badge; `null` renders the quiet, untinted variant. */
export type ContextUsageAccent = 'info' | 'destructive' | null

export interface ContextUsage {
  /** Whole-percent share for the compact badge label, 0–100. */
  percent: number
  /** Same share at one decimal for the hover readout, e.g. `"27.0%"`. */
  percentText: string
  /** Tokens on the wire, e.g. `"270.1K"`. */
  usedText: string
  /** Window they are measured against, e.g. `"1.0M"`. */
  totalText: string
  accent: ContextUsageAccent
  /** False while a turn or a compaction is already running. */
  canCompact: boolean
}

/** Amber once the window is mostly spent, red once auto-compaction is imminent. */
const INFO_AT_PERCENT = 75
const DESTRUCTIVE_AT_PERCENT = 90

/**
 * Compact token count keeping one decimal: 270_100 → `"270.1K"`, 1_000_000 → `"1.0M"`.
 *
 * Deliberately finer than the model picker's `formatTokenCount`, which drops the
 * decimal above 10k. "270k / 1M" cannot distinguish 270k from 279k, and answering
 * "how much room is left" is the whole reason this readout exists.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(Math.round(tokens))
}

/**
 * Derive the badge state, or null when there is nothing truthful to show —
 * an unknown window, or a session that has not consumed any context yet.
 */
export function deriveContextUsage(input: ContextUsageInput): ContextUsage | null {
  const usedTokens = input.usedTokens ?? 0
  // A window smaller than the tokens already on the wire cannot be this session's
  // window — that request would have been rejected. Reopening a session persisted
  // before the backend learned the real window lands here, and so does a mid-session
  // switch to a wider model. Fall back to the registry instead of rendering the
  // impossible pair.
  const reported = input.reportedContextWindow
  const trustedReported = reported && reported >= usedTokens ? reported : undefined
  const contextWindow = trustedReported || input.fallbackContextWindow
  if (!contextWindow || contextWindow <= 0 || usedTokens <= 0) return null

  const share = Math.min(1, usedTokens / contextWindow)
  const percent = Math.round(share * 100)
  return {
    percent,
    percentText: `${(share * 100).toFixed(1)}%`,
    usedText: formatTokens(usedTokens),
    totalText: formatTokens(contextWindow),
    accent: percent >= DESTRUCTIVE_AT_PERCENT
      ? 'destructive'
      : percent >= INFO_AT_PERCENT
        ? 'info'
        : null,
    canCompact: !input.isProcessing && !input.isCompacting,
  }
}
