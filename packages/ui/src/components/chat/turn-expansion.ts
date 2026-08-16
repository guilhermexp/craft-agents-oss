/**
 * turn-expansion.ts
 *
 * The single source of truth for the `autoExpand` polarity. Both turn cards and
 * activity groups keep two override sets — ids the user explicitly expanded and
 * ids they explicitly collapsed — and `autoExpand` picks which set is the
 * "override from default":
 *
 *   - autoExpand off (historical default): everything collapsed unless the id is
 *     in `expanded`.
 *   - autoExpand on: everything expanded unless the id is in `collapsed`.
 *
 * Keeping both sets means flipping the global toggle off and back on preserves
 * the user's per-id intent. This module resolves that polarity once so no
 * component ever re-derives the inverted-set semantics again.
 *
 * `autoExpand` is a WINDOW, not a permanent default: it applies only while the
 * turn is still in flight (see `autoExpandApplies`), so a turn expands as the
 * agent works and collapses again once it settles.
 */

/** The two override sets for one expansion axis (turns or groups). */
export interface ExpansionState {
  /** Ids the user explicitly expanded — the active set when autoExpand is off. */
  expanded: ReadonlySet<string>
  /** Ids the user explicitly collapsed — the active set when autoExpand is on. */
  collapsed: ReadonlySet<string>
}

/** Resolve whether an id is currently expanded, given the autoExpand default. */
export function isIdExpanded(state: ExpansionState, autoExpand: boolean, id: string): boolean {
  return autoExpand ? !state.collapsed.has(id) : state.expanded.has(id)
}

/**
 * Record the user's intent for an id, returning updated override sets. Only the
 * set that is active for the current polarity changes; the other is preserved
 * verbatim so it survives an autoExpand flip. Returns the same-shaped state with
 * a fresh active set (new reference) so React sees the change.
 */
export function applyExpansionToggle(
  state: ExpansionState,
  autoExpand: boolean,
  id: string,
  expanded: boolean,
): ExpansionState {
  if (autoExpand) {
    // Active set is `collapsed`: presence means collapsed.
    const collapsed = new Set(state.collapsed)
    if (expanded) collapsed.delete(id)
    else collapsed.add(id)
    return { expanded: state.expanded, collapsed }
  }
  // Active set is `expanded`: presence means expanded.
  const expandedSet = new Set(state.expanded)
  if (expanded) expandedSet.add(id)
  else expandedSet.delete(id)
  return { expanded: expandedSet, collapsed: state.collapsed }
}

/**
 * Resolve whether the auto-expand default applies to a turn right now.
 *
 * The setting opens activities so the user can watch a turn happen; it is not a
 * request to leave the whole transcript exploded. So the expanded default is
 * scoped to the turn's in-flight window and the polarity reverts to collapsed
 * once the turn settles — that reversal IS the auto-collapse on completion, with
 * no extra state to schedule, persist, or reconcile.
 *
 * Because the polarity flips at completion, the ACTIVE override set flips with
 * it, and the resulting behavior is the one users expect from both sets:
 *   - collapsing a turn mid-flight records it in `collapsed` (active while in
 *     flight), so it stays shut for the rest of the turn;
 *   - expanding a settled turn records it in `expanded` (active once settled),
 *     so re-reading an old turn persists across renders and session switches.
 *
 * `isTurnInFlight` must be the turn's completion state (`!isComplete`), never
 * `isStreaming`: streaming drops to false between tool calls, which would
 * collapse and re-expand the card on every step of a working turn.
 */
export function autoExpandApplies(autoExpand: boolean, isTurnInFlight: boolean): boolean {
  return autoExpand && isTurnInFlight
}
