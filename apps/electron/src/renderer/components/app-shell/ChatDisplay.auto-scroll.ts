interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

interface StreamingPinState {
  isFocusedPanel: boolean
  isStickToBottom: boolean
  skipUntil: number
  now: number
}

type OverflowYReader = (element: Element) => string

const WHEEL_SCROLLABLE_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay'])

/** Pixels between the current scroll position and the very bottom of the content. */
export function scrollDistanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

export function isNearScrollBottom(metrics: ScrollMetrics, threshold = 20): boolean {
  return scrollDistanceFromBottom(metrics) < threshold
}

export function shouldPinStreamingContentToBottom(state: StreamingPinState): boolean {
  if (state.isFocusedPanel && !state.isStickToBottom) return false
  return state.now >= state.skipUntil
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') return null

  const node = target as Node
  if (node.nodeType === 1) return node as Element
  return node.parentElement ?? null
}

function readComputedOverflowY(element: Element): string {
  return element.ownerDocument.defaultView?.getComputedStyle(element).overflowY ?? ''
}

export function canNestedScrollerConsumeUpwardWheel(
  viewport: EventTarget,
  eventTarget: EventTarget | null,
  readOverflowY: OverflowYReader = readComputedOverflowY,
): boolean {
  let element = eventTargetElement(eventTarget)

  // Follow only the event's ancestor chain. The viewport is deliberately
  // excluded: reaching it means normal scroll chaining should unstick chat.
  while (element && element !== viewport) {
    if (element.scrollHeight > element.clientHeight && element.scrollTop > 0) {
      const overflowY = readOverflowY(element).trim().toLowerCase()
      if (WHEEL_SCROLLABLE_OVERFLOW_VALUES.has(overflowY)) return true
    }
    element = element.parentElement
  }

  return false
}

export function attachUpwardWheelIntentListener(
  target: EventTarget,
  onUpwardWheel: () => void,
  readOverflowY: OverflowYReader = readComputedOverflowY,
): () => void {
  const handleWheel: EventListener = (event) => {
    if (
      (event as WheelEvent).deltaY < 0
      && !canNestedScrollerConsumeUpwardWheel(target, event.target, readOverflowY)
    ) {
      onUpwardWheel()
    }
  }

  target.addEventListener('wheel', handleWheel, { passive: true })
  return () => target.removeEventListener('wheel', handleWheel)
}
