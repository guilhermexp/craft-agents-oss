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
