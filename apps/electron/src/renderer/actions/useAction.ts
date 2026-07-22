import { useEffect, useRef } from 'react'
import { useActionRegistry } from './registry'
import type { ActionId } from './definitions'

/**
 * Register a handler for an action.
 *
 * @example
 * useAction('app.newChat', () => handleNewChat())
 *
 * @example
 * // With enabled condition
 * useAction('navigator.selectAll', selectAll, {
 *   enabled: () => zoneRef.current?.contains(document.activeElement) ?? false
 * })
 */
export function useAction(
  actionId: ActionId,
  handler: () => void,
  options?: { enabled?: () => boolean },
  deps: unknown[] = []
) {
  const { register } = useActionRegistry()
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)

  // Keep the refs pointing at the latest handler/options after every commit.
  // `handler`/`options` are freshly allocated each render, so the previous
  // [handler, options, ...deps] array already re-ran this effect on every
  // render; an unconditional effect preserves that exactly without depending
  // on freshly-allocated references.
  useEffect(() => {
    handlerRef.current = handler
    optionsRef.current = options
  })

  // Register handler
  useEffect(() => {
    return register({
      actionId,
      handler: () => handlerRef.current(),
      enabled: optionsRef.current?.enabled ? () => optionsRef.current?.enabled?.() ?? false : undefined,
    })
  }, [actionId, register])
}
