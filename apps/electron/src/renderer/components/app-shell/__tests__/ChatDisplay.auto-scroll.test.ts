import { describe, expect, it, mock } from 'bun:test'
import {
  attachUpwardWheelIntentListener,
  canNestedScrollerConsumeUpwardWheel,
  isNearScrollBottom,
  shouldPinStreamingContentToBottom,
} from '../ChatDisplay.auto-scroll'

interface TestElement {
  nodeType: 1
  parentElement: TestElement | null
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  overflowY: string
}

function testElement(overrides: Partial<TestElement> = {}): TestElement {
  return {
    nodeType: 1,
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    overflowY: 'visible',
    ...overrides,
  }
}

const readTestOverflowY = (element: Element): string =>
  (element as unknown as TestElement).overflowY

class ControlledWheelTarget {
  private readonly wheelListeners = new Set<EventListenerOrEventListenerObject>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'wheel' && listener) this.wheelListeners.add(listener)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'wheel' && listener) this.wheelListeners.delete(listener)
  }

  emitWheel(deltaY: number, target: EventTarget): void {
    const event = { deltaY, target } as unknown as Event
    for (const listener of this.wheelListeners) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }
}

function wheelEvent(deltaY: number): Event {
  const event = new Event('wheel')
  Object.defineProperty(event, 'deltaY', { value: deltaY })
  return event
}

describe('ChatDisplay streaming auto-scroll wheel guard', () => {
  it.each(['auto', 'scroll', 'overlay'])('ignores upward wheel consumed by nested overflow-y: %s content', (overflowY) => {
    const viewport = testElement({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
    const nestedScroller = testElement({
      parentElement: viewport,
      scrollTop: 24,
      scrollHeight: 300,
      clientHeight: 100,
      overflowY,
    })

    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      nestedScroller as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(true)
  })

  it('allows scroll chaining when every nested scroller is already at its top boundary', () => {
    const viewport = testElement({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400, overflowY: 'auto' })
    const outerScroller = testElement({
      parentElement: viewport,
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 100,
      overflowY: 'overlay',
    })
    const innerScroller = testElement({
      parentElement: outerScroller,
      scrollTop: 0,
      scrollHeight: 300,
      clientHeight: 100,
      overflowY: 'scroll',
    })
    const textTarget = { nodeType: 3, parentElement: innerScroller }

    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      textTarget as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(false)
  })

  it('does not consume wheel intent without both vertical overflow and scrollable dimensions', () => {
    const viewport = testElement()
    const noScrollableRange = testElement({
      parentElement: viewport,
      scrollTop: 10,
      scrollHeight: 100,
      clientHeight: 100,
      overflowY: 'auto',
    })
    const visibleOverflow = testElement({
      parentElement: viewport,
      scrollTop: 10,
      scrollHeight: 300,
      clientHeight: 100,
      overflowY: 'visible',
    })

    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      noScrollableRange as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(false)
    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      visibleOverflow as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(false)
  })

  it('checks each nested ancestor and stops before treating the viewport as nested', () => {
    const viewport = testElement({
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
      overflowY: 'auto',
    })
    const consumableOuterScroller = testElement({
      parentElement: viewport,
      scrollTop: 10,
      scrollHeight: 400,
      clientHeight: 100,
      overflowY: 'auto',
    })
    const innerAtTop = testElement({
      parentElement: consumableOuterScroller,
      scrollTop: 0,
      scrollHeight: 300,
      clientHeight: 100,
      overflowY: 'auto',
    })

    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      innerAtTop as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(true)
    expect(canNestedScrollerConsumeUpwardWheel(
      viewport as unknown as EventTarget,
      viewport as unknown as EventTarget,
      readTestOverflowY,
    )).toBe(false)
  })

  it('disables sticky mode only after a nested scroller reaches its top boundary', () => {
    const viewport = Object.assign(
      new ControlledWheelTarget(),
      testElement({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400, overflowY: 'auto' }),
    )
    const nestedScroller = testElement({
      parentElement: viewport as unknown as TestElement,
      scrollTop: 10,
      scrollHeight: 300,
      clientHeight: 100,
      overflowY: 'auto',
    })
    const onUpwardWheel = mock(() => {})
    const detach = attachUpwardWheelIntentListener(
      viewport as unknown as EventTarget,
      onUpwardWheel,
      readTestOverflowY,
    )

    viewport.emitWheel(-1, nestedScroller as unknown as EventTarget)
    expect(onUpwardWheel).not.toHaveBeenCalled()

    nestedScroller.scrollTop = 0
    viewport.emitWheel(-1, nestedScroller as unknown as EventTarget)
    expect(onUpwardWheel).toHaveBeenCalledTimes(1)

    detach()
  })

  it('prevents a streaming resize snap after upward wheel and resumes once back at bottom', () => {
    const target = new EventTarget()
    let isStickToBottom = true
    const detach = attachUpwardWheelIntentListener(target, () => {
      isStickToBottom = false
    })

    expect(shouldPinStreamingContentToBottom({
      isFocusedPanel: true,
      isStickToBottom,
      skipUntil: 0,
      now: 1,
    })).toBe(true)

    target.dispatchEvent(wheelEvent(-1))
    expect(isStickToBottom).toBe(false)
    expect(shouldPinStreamingContentToBottom({
      isFocusedPanel: true,
      isStickToBottom,
      skipUntil: 0,
      now: 1,
    })).toBe(false)

    isStickToBottom = isNearScrollBottom({
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
    })
    expect(isStickToBottom).toBe(true)
    expect(shouldPinStreamingContentToBottom({
      isFocusedPanel: true,
      isStickToBottom,
      skipUntil: 0,
      now: 1,
    })).toBe(true)

    detach()
  })

  it('handles upward wheel intent synchronously without affecting downward wheel', () => {
    const target = new EventTarget()
    const onUpwardWheel = mock(() => {})
    const detach = attachUpwardWheelIntentListener(target, onUpwardWheel)

    target.dispatchEvent(wheelEvent(12))
    expect(onUpwardWheel).not.toHaveBeenCalled()

    target.dispatchEvent(wheelEvent(-1))
    expect(onUpwardWheel).toHaveBeenCalledTimes(1)

    detach()
  })

  it('registers passively and removes the listener during cleanup', () => {
    const target = new EventTarget()
    const originalAddEventListener = target.addEventListener.bind(target)
    let wheelOptions: AddEventListenerOptions | boolean | undefined
    target.addEventListener = ((type, listener, options) => {
      if (type === 'wheel') wheelOptions = options
      originalAddEventListener(type, listener, options)
    }) as EventTarget['addEventListener']

    const onUpwardWheel = mock(() => {})
    const detach = attachUpwardWheelIntentListener(target, onUpwardWheel)

    expect(wheelOptions).toEqual({ passive: true })

    detach()
    target.dispatchEvent(wheelEvent(-1))
    expect(onUpwardWheel).not.toHaveBeenCalled()
  })
})
