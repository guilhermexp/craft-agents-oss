---
name: computer-use
description: Control supported macOS apps through stateful semantic UI discovery, observation, validated actions, and managed browser contexts.
---

# Computer Use

Use these tools when shell and file operations cannot complete work that
requires a visible macOS application.

## Stateful workflow

1. Call `find_roots` when you need to discover or switch the target app,
   window, dialog, menu, or managed browser page. Keep the exact `@r` root ref.
2. Call `observe_ui` for that root (or the frontmost supported root). Use
   `semantic` mode when structure is sufficient, `visual` when image evidence
   is required, and `fused` for automatic selection.
3. Keep the returned `stateId`. Every `@e` element ref belongs to that state.
4. Use `search_ui` to find omitted targets, `expand_ui` for bounded subtree
   context, and `inspect_ui` when capabilities, geometry, or provenance must be
   confirmed.
5. Use `act_ui` with the current `stateId`. Prefer semantic refs; use points
   only when the observed evidence leaves no reliable ref. Group dependent
   actions only when their order is known, and use `expect` for observable
   completion.
6. After navigation or mutation, use the successor state returned by the tool.
   Re-observe when the UI changed unexpectedly or a state/ref is stale.

## Reading and waiting

- Use `read_text` to page through text from an `@e` UI ref. Pass its owning
  `stateId`. Immutable `@o` continuation refs do not require a state.
- Use `wait_for` for bounded asynchronous conditions instead of polling. Scope
  the condition by ref, subtree, text, role, or value whenever possible.
- Treat every ref as state-scoped. Never reuse a ref with a different state.

## Browser contexts

- Use `launch_browser` only when work needs the Pi-managed CDP browser.
- Use `navigate_browser` with the current browser-page `stateId` for HTTP(S)
  navigation.
- Use `evaluate_browser` only for targeted, bounded JavaScript. Prefer normal
  observation, search, and text reading when they are sufficient.
- Native browser windows remain regular UI roots and should be operated through
  observation and validated UI actions.

## Safety and recovery

- Prefer the smallest action set that can satisfy the request.
- Do not act on ambiguous targets. Narrow the search or inspect the candidate.
- Re-observe after any unexpected focus, window, or content change.
- Accessibility permission is required for interaction; Screen Recording is
  required for visual evidence.
- If setup or permission checks fail, report the exact remediation and stop
  instead of attempting ungrounded actions.

The public tool surface is exactly `find_roots`, `observe_ui`, `search_ui`,
`expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`, `launch_browser`,
`navigate_browser`, and `evaluate_browser`.
