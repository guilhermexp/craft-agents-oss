/**
 * Tests for BrowserCDP (Chrome DevTools Protocol helpers).
 *
 * Mocks webContents.debugger to test accessibility snapshots,
 * element interaction, and CDP lifecycle management.
 */

import { describe, it, expect, beforeEach, mock, jest } from 'bun:test'
import type { WebContents } from 'electron'
import { createLoggerModuleStub } from './logger-module-stub'

// Mock logger before import
mock.module('../logger', () => createLoggerModuleStub())

const { BrowserCDP, decideIdleDetach, translateCdpNodeError } = await import('../browser-cdp')

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockWebContents(
  sendCommandImpl?: (method: string, params?: any) => Promise<any>,
  // Left throwing by default: the real webContents.sendInputEvent is only
  // reachable in a live Electron process, and code paths that reach for it
  // must be exercised deliberately.
  sendInputEventImpl?: (event: Record<string, unknown>) => void,
) {
  const listeners: Record<string, Function[]> = {}
  const wcListeners: Record<string, Function[]> = {}
  return {
    debugger: {
      attach: mock((_version: string) => {}),
      detach: mock(() => {}),
      sendCommand: mock(sendCommandImpl ?? (async () => ({ nodes: [] }))),
      on: mock((event: string, cb: Function) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      }),
    },
    on: mock((event: string, cb: Function) => {
      if (!wcListeners[event]) wcListeners[event] = []
      wcListeners[event].push(cb)
    }),
    getURL: mock(() => 'https://example.com'),
    getTitle: mock(() => 'Example Page'),
    sendInputEvent: mock(sendInputEventImpl ?? (() => {
      throw new Error('sendInputEvent is not wired in this mock')
    })),
    _debuggerListeners: listeners,
    _triggerDetach: () => {
      for (const cb of listeners['detach'] || []) cb()
    },
    _triggerNavigate: (event: 'did-navigate' | 'did-navigate-in-page' | 'did-frame-navigate' = 'did-navigate') => {
      for (const cb of wcListeners[event] || []) cb()
    },
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('BrowserCDP', () => {
  describe('ensureAttached', () => {
    it('attaches debugger on first call', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Trigger attach via a CDP command
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
      expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    })

    it('skips attach on subsequent calls', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      await cdp.getAccessibilitySnapshot()
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
    })

    it('handles already-attached error gracefully', async () => {
      const wc = createMockWebContents()
      wc.debugger.attach = mock(() => { throw new Error('Already attached to this target') })
      const cdp = new BrowserCDP(wc as any)

      // Should not throw
      await cdp.getAccessibilitySnapshot()
      expect(wc.debugger.sendCommand).toHaveBeenCalled()
    })

    it('registers detach listener only once', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Trigger ensureAttached multiple times by simulating detach + re-attach
      await cdp.getAccessibilitySnapshot()

      // Simulate detach
      wc._triggerDetach()

      // Re-attach
      await cdp.getAccessibilitySnapshot()

      // The 'on' for 'detach' should only be called once (guard prevents duplicates)
      const detachCalls = (wc.debugger.on as any).mock.calls.filter(
        (call: any[]) => call[0] === 'detach'
      )
      expect(detachCalls.length).toBe(1)
    })
  })

  describe('getAccessibilitySnapshot', () => {
    it('parses AX tree nodes and assigns refs', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 },
              { role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'test@example.com' }, backendDOMNodeId: 101, properties: [
                { name: 'focused', value: { value: true } },
              ]},
              { role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 102 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.url).toBe('https://example.com')
      expect(snapshot.title).toBe('Example Page')
      expect(snapshot.nodes).toHaveLength(3)

      expect(snapshot.nodes[0].ref).toBe('@e1')
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')

      expect(snapshot.nodes[1].ref).toBe('@e2')
      expect(snapshot.nodes[1].value).toBe('test@example.com')
      expect(snapshot.nodes[1].focused).toBe(true)

      expect(snapshot.nodes[2].ref).toBe('@e3')
      expect(snapshot.nodes[2].role).toBe('link')
    })

    it('keeps refs stable for same backend nodes across reordered snapshots', async () => {
      let snapshotCallCount = 0
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          snapshotCallCount += 1

          if (snapshotCallCount === 1) {
            return {
              nodes: [
                { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'created-oldest' }, backendDOMNodeId: 200 },
                { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              ],
            }
          }

          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'updated-newest' }, backendDOMNodeId: 200 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const first = await cdp.getAccessibilitySnapshot()
      const second = await cdp.getAccessibilitySnapshot()

      const firstSortRef = first.nodes.find((n) => n.name === 'Sort')?.ref
      const secondSortRef = second.nodes.find((n) => n.name === 'Sort')?.ref

      expect(firstSortRef).toBeDefined()
      expect(secondSortRef).toBeDefined()
      expect(firstSortRef).toBe(secondSortRef)
    })

    it('skips non-interactive, non-content nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'generic' }, name: { value: '' } },       // Filtered: generic + no name
              { role: { value: 'none' }, name: { value: '' } },          // Filtered: none + no name
              { role: { value: 'button' }, name: { value: 'OK' } },      // Kept: interactive
              { role: { value: 'heading' }, name: { value: 'Title' } },  // Kept: content + name
              { role: { value: 'heading' }, name: { value: '' } },       // Filtered: content without name
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[1].role).toBe('heading')
    })

    it('caps at 500 nodes', async () => {
      const manyNodes = Array.from({ length: 600 }, (_, i) => ({
        role: { value: 'button' },
        name: { value: `Button ${i}` },
        backendDOMNodeId: i,
      }))

      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: manyNodes }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(500)
      expect(snapshot.nodes[499].ref).toBe('@e500')
    })

    it('normalizes role casing for primary filtering', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'Button' }, name: { value: 'Submit' }, backendDOMNodeId: 1 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')
    })

    it('uses fallback selection when primary filtering keeps zero nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'grouping' }, name: { value: 'Recents List' }, backendDOMNodeId: 21 },
              { role: { value: 'pane' }, name: { value: 'Shared Files' }, backendDOMNodeId: 22 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].name).toBe('Recents List')
      expect(snapshot.nodes[1].name).toBe('Shared Files')
    })

    it('keeps fallback nodes clickable through ref mapping', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'pane' }, name: { value: 'Canvas Action' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-42' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')
    })
  })

  describe('clickElement', () => {
    it('throws for unknown ref', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      await expect(cdp.clickElement('@e99')).rejects.toThrow('not found')
    })

    it('resolves node and dispatches mouse events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method, params) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Click' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-42' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot() // Populate refMap

      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('DOM.getBoxModel')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')

      const scrollIndex = sentCommands.indexOf('Runtime.callFunctionOn')
      const boxModelIndex = sentCommands.indexOf('DOM.getBoxModel')
      expect(scrollIndex).toBeGreaterThan(-1)
      expect(boxModelIndex).toBeGreaterThan(-1)
      expect(scrollIndex).toBeLessThan(boxModelIndex)
    })
  })

  describe('ref invalidation on navigation (F2.3)', () => {
    function createNavMockWebContents(nodesByCall?: (call: number) => any[]) {
      let call = 0
      return createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          call += 1
          return {
            nodes: nodesByCall?.(call) ?? [
              { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 + call },
            ],
          }
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        return {}
      })
    }

    it('rejects a ref used after did-navigate without a fresh snapshot', async () => {
      const wc = createNavMockWebContents()
      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      wc._triggerNavigate('did-navigate')

      await expect(cdp.clickElement('@e1')).rejects.toThrow('stale')
      await expect(cdp.fillElement('@e1', 'x')).rejects.toThrow('browser_snapshot')
      await expect(cdp.selectOption('@e1', 'x')).rejects.toThrow('stale')
    })

    it('rejects a ref after in-page (SPA) navigation', async () => {
      const wc = createNavMockWebContents()
      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      wc._triggerNavigate('did-navigate-in-page')

      await expect(cdp.clickElement('@e1')).rejects.toThrow('stale')
    })

    it('rejects a ref after subframe navigation (F7/R4)', async () => {
      const wc = createNavMockWebContents()
      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      // Only an iframe navigates — main frame stays put
      wc._triggerNavigate('did-frame-navigate')

      await expect(cdp.clickElement('@e1')).rejects.toThrow('stale')
      await expect(cdp.fillElement('@e1', 'x')).rejects.toThrow('browser_snapshot')
    })

    it('never reuses pre-navigation ref numbers after a fresh snapshot', async () => {
      const wc = createNavMockWebContents(() => [
        // Same backendDOMNodeId across snapshots — without invalidation the
        // stable map would hand the old ref back to the new document.
        { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 },
      ])
      const cdp = new BrowserCDP(wc as any)
      const before = await cdp.getAccessibilitySnapshot()
      expect(before.nodes[0].ref).toBe('@e1')

      wc._triggerNavigate('did-navigate')
      const after = await cdp.getAccessibilitySnapshot()

      // Counter is monotonic: post-navigation snapshot allocates a new ref.
      expect(after.nodes[0].ref).toBe('@e2')
      await expect(cdp.clickElement('@e1')).rejects.toThrow('stale')
      // Fresh ref from the current snapshot works.
      await cdp.clickElement('@e2')
    })

    it('keeps refs stable across snapshots of the same document (no navigation)', async () => {
      const wc = createNavMockWebContents(() => [
        { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 },
      ])
      const cdp = new BrowserCDP(wc as any)
      const first = await cdp.getAccessibilitySnapshot()
      const second = await cdp.getAccessibilitySnapshot()

      expect(first.nodes[0].ref).toBe('@e1')
      expect(second.nodes[0].ref).toBe('@e1')
    })
  })

  describe('fillElement', () => {
    it('focuses, clears, and types characters', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'textbox' }, name: { value: 'Input' }, backendDOMNodeId: 10 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-10' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      await cdp.fillElement('@e1', 'ab')

      expect(sentCommands).toContain('DOM.focus')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
      // Two characters typed: 2 keyDown + 2 keyUp = 4 key events
      const keyEvents = sentCommands.filter(c => c === 'Input.dispatchKeyEvent')
      expect(keyEvents.length).toBe(4)
    })
  })

  describe('selectOption', () => {
    it('sets value and dispatches events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'combobox' }, name: { value: 'Country' }, backendDOMNodeId: 20 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-20' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      await cdp.selectOption('@e1', 'US')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
    })
  })

  describe('drag', () => {
    it('dispatches pressed -> moved -> released with expected button state', async () => {
      const mouseEvents: any[] = []
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(params)
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.drag(10, 20, 110, 20)

      expect(mouseEvents.length).toBeGreaterThan(2)
      expect(mouseEvents[0]).toMatchObject({
        type: 'mousePressed',
        x: 10,
        y: 20,
        button: 'left',
        buttons: 1,
      })

      const movedEvents = mouseEvents.filter((event) => event.type === 'mouseMoved')
      expect(movedEvents.length).toBeGreaterThan(0)
      for (const event of movedEvents) {
        expect(event.buttons).toBe(1)
      }

      const lastEvent = mouseEvents[mouseEvents.length - 1]
      expect(lastEvent).toMatchObject({
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
      })
    })

    it('attempts release even when a move event fails and rethrows original error', async () => {
      const mouseEvents: any[] = []
      let failedOnce = false
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(params)
          if (params?.type === 'mouseMoved' && !failedOnce) {
            failedOnce = true
            throw new Error('move failed')
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await expect(cdp.drag(0, 0, 100, 0)).rejects.toThrow('move failed')
      expect(mouseEvents.some((event) => event.type === 'mouseReleased')).toBe(true)
    })
  })

  describe('detach', () => {
    it('detaches debugger', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Attach first
      await cdp.getAccessibilitySnapshot()

      cdp.detach()
      expect(wc.debugger.detach).toHaveBeenCalled()
    })

    it('is safe to call when not attached', () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Should not throw
      expect(() => cdp.detach()).not.toThrow()
    })
  })

  describe('decideIdleDetach', () => {
    it('detaches only when attached with nothing in flight', () => {
      expect(decideIdleDetach({ attached: true, inflight: 0 })).toBe('detach')
    })

    it('re-arms while a command is in flight', () => {
      expect(decideIdleDetach({ attached: true, inflight: 1 })).toBe('re-arm')
      expect(decideIdleDetach({ attached: true, inflight: 3 })).toBe('re-arm')
    })

    it('does nothing when already detached', () => {
      expect(decideIdleDetach({ attached: false, inflight: 0 })).toBe('idle')
      expect(decideIdleDetach({ attached: false, inflight: 2 })).toBe('idle')
    })
  })

  describe('idle detach in-flight gate', () => {
    async function waitForFirstCommand(dispatched: () => number): Promise<void> {
      for (let i = 0; i < 50; i++) {
        if (dispatched() > 0) return
        await Promise.resolve()
      }
      throw new Error('sendCommand was never dispatched')
    }

    it('re-arms instead of detaching while a command awaits its response', async () => {
      jest.useFakeTimers()
      try {
        const { promise, resolve } = Promise.withResolvers<unknown>()
        const wc = createMockWebContents(() => promise)
        const cdp = new BrowserCDP(wc as unknown as WebContents)

        const pending = cdp.getClipboard()
        await waitForFirstCommand(() => wc.debugger.sendCommand.mock.calls.length)

        // Four idle deadlines pass with the command still in flight.
        jest.advanceTimersByTime(20_000)
        expect(wc.debugger.detach).not.toHaveBeenCalled()

        resolve({ result: { value: 'copied' } })
        await expect(pending).resolves.toBe('copied')

        jest.advanceTimersByTime(6_000)
        expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('releases the gate when the in-flight command rejects', async () => {
      jest.useFakeTimers()
      try {
        const { promise, reject } = Promise.withResolvers<unknown>()
        const wc = createMockWebContents(() => promise)
        const cdp = new BrowserCDP(wc as unknown as WebContents)

        const pending = cdp.getClipboard()
        await waitForFirstCommand(() => wc.debugger.sendCommand.mock.calls.length)

        reject(new Error('Protocol error: something else'))
        await expect(pending).rejects.toThrow('Protocol error')

        jest.advanceTimersByTime(6_000)
        expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('clickAtCoordinates failure handling', () => {
    it('re-attaches and replays through CDP when the debugger is lost mid-click', async () => {
      const dispatched: Array<Record<string, unknown>> = []
      let triggerDetach: (() => void) | undefined
      let failedOnce = false
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          if (params?.type === 'mousePressed' && !failedOnce) {
            failedOnce = true
            triggerDetach?.()
            throw new Error('target closed while handling command')
          }
          dispatched.push(params ?? {})
        }
        return {}
      })
      triggerDetach = wc._triggerDetach

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.clickAtCoordinates(30, 40)

      expect(wc.debugger.attach).toHaveBeenCalledTimes(2)
      const replayed = dispatched.filter(e => e.type === 'mousePressed' || e.type === 'mouseReleased')
      expect(replayed.map(e => e.type)).toEqual(['mousePressed', 'mouseReleased'])
      expect(replayed[0]).toMatchObject({ x: 30, y: 40 })
    })

    it('rejects without native input when the CDP replay also fails', async () => {
      let triggerDetach: (() => void) | undefined
      const wc = createMockWebContents(
        async (method, params) => {
          if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
            triggerDetach?.()
            throw new Error('target closed while handling command')
          }
          return {}
        },
        () => {},
      )
      triggerDetach = wc._triggerDetach

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await expect(cdp.clickAtCoordinates(10, 10)).rejects.toThrow('the debugger session was lost')
      expect(wc.sendInputEvent).not.toHaveBeenCalled()
    })

    it('rejects without a second down/up pair when the press was already delivered', async () => {
      const wc = createMockWebContents(
        async (_method, params) => {
          if (params?.type === 'mouseReleased') {
            throw new Error('Input dispatch rejected by renderer')
          }
          return {}
        },
        () => {},
      )

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await expect(cdp.clickAtCoordinates(5, 6)).rejects.toThrow('Input dispatch rejected by renderer')
      expect(wc.sendInputEvent).not.toHaveBeenCalled()
    })

    it('falls back to native input, moving first, when nothing was pressed yet', async () => {
      const native: Array<Record<string, unknown>> = []
      const wc = createMockWebContents(
        async (_method, params) => {
          if (params?.type === 'mouseMoved') {
            throw new Error('Input dispatch rejected by renderer')
          }
          return {}
        },
        (event) => { native.push(event) },
      )

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.clickAtCoordinates(12, 34)

      expect(native.map(e => e.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
      expect(native[0]).toMatchObject({ x: 12, y: 34 })
    })

    it('propagates a failing native fallback instead of reporting success', async () => {
      const wc = createMockWebContents(
        async (_method, params) => {
          if (params?.type === 'mouseMoved') {
            throw new Error('Input dispatch rejected by renderer')
          }
          return {}
        },
        () => { throw new Error('native input unavailable') },
      )

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await expect(cdp.clickAtCoordinates(1, 2)).rejects.toThrow('native input unavailable')
    })
  })

  describe('post-action geometry is best-effort', () => {
    function createFillMock(boxModel: (call: number) => unknown) {
      let boxCalls = 0
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 7 }] }
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-7' } }
        if (method === 'DOM.getBoxModel') {
          boxCalls += 1
          return boxModel(boxCalls)
        }
        return {}
      })
      return { wc, sentCommands }
    }

    it('returns the pre-action geometry when the fill navigates the page away', async () => {
      const { wc } = createFillMock((call) => {
        if (call === 1) return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        throw new Error('Node cannot be found in the current page.')
      })

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.getAccessibilitySnapshot()

      const geometry = await cdp.fillElement('@e1', 'user@example.com')
      expect(geometry.box).toEqual({ x: 10, y: 10, width: 40, height: 40 })
    })

    it('still fills an element it cannot measure, then reports the read error', async () => {
      const { wc, sentCommands } = createFillMock(() => { throw new Error('Could not compute box model.') })

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.getAccessibilitySnapshot()

      await expect(cdp.fillElement('@e1', 'ab')).rejects.toThrow('Could not compute box model')
      expect(sentCommands.filter(c => c === 'Input.dispatchKeyEvent').length).toBe(4)
    })

    it('still rejects a click whose target geometry cannot be resolved', async () => {
      const { wc } = createFillMock(() => { throw new Error('Could not compute box model.') })

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.getAccessibilitySnapshot()

      await expect(cdp.clickElement('@e1')).rejects.toThrow('Failed to click @e1')
    })
  })

  describe('translateCdpNodeError', () => {
    it('maps Blink stale-node wording onto the actionable stale-ref message', () => {
      const translated = translateCdpNodeError(new Error('Node cannot be found in the current page.'))
      expect((translated as Error).message).toContain('the ref is stale')
      expect((translated as Error).message).toContain('browser_snapshot')
    })

    it('maps the other missing-node wording too', () => {
      const translated = translateCdpNodeError(new Error('No node with given id found'))
      expect((translated as Error).message).toContain('browser_snapshot')
    })

    it('leaves unrelated protocol errors untouched', () => {
      const original = new Error('Protocol error (Runtime.evaluate): Target crashed')
      expect(translateCdpNodeError(original)).toBe(original)
    })

    it('reaches the caller through a real command path', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 3 }] }
        }
        if (method === 'DOM.getBoxModel') throw new Error('Node cannot be found in the current page.')
        return {}
      })

      const cdp = new BrowserCDP(wc as unknown as WebContents)
      await cdp.getAccessibilitySnapshot()

      await expect(cdp.getElementGeometry('@e1')).rejects.toThrow('browser_snapshot')
    })
  })
})
