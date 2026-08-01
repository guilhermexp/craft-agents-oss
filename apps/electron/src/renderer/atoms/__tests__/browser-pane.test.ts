import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { BrowserInstanceInfo } from '../../../shared/types'
import {
  browserInstancesAtom,
  integratedBrowserInstanceIdAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '../browser-pane'

function makeInstance(id: string): BrowserInstanceInfo {
  return {
    id,
    profileId: 'default',
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
  }
}

describe('browser pane atoms', () => {
  it('does not resurrect removed instance from stale update event', () => {
    const store = createStore()

    store.set(updateBrowserInstanceAtom, makeInstance('browser-1'))
    expect(store.get(browserInstancesAtom).map((i) => i.id)).toEqual(['browser-1'])

    store.set(removeBrowserInstanceAtom, 'browser-1')
    expect(store.get(browserInstancesAtom)).toHaveLength(0)

    // Simulate late out-of-order state event arriving after removal
    store.set(updateBrowserInstanceAtom, makeInstance('browser-1'))

    expect(store.get(browserInstancesAtom)).toHaveLength(0)
  })

  it('authoritative list refresh can restore an instance after prior remove', () => {
    const store = createStore()

    store.set(removeBrowserInstanceAtom, 'browser-2')
    expect(store.get(browserInstancesAtom)).toHaveLength(0)

    // Simulate full list() reconciliation from main process
    store.set(setBrowserInstancesAtom, [makeInstance('browser-2')])

    expect(store.get(browserInstancesAtom).map((i) => i.id)).toEqual(['browser-2'])
  })

  it('clears the integrated card when its instance is removed', () => {
    const store = createStore()
    store.set(setBrowserInstancesAtom, [makeInstance('browser-1')])
    store.set(integratedBrowserInstanceIdAtom, 'browser-1')

    store.set(removeBrowserInstanceAtom, 'browser-1')

    // Otherwise the full-window overlay outlives the browser it framed.
    expect(store.get(integratedBrowserInstanceIdAtom)).toBeNull()
  })

  it('leaves the integrated card alone when a different instance is removed', () => {
    const store = createStore()
    store.set(setBrowserInstancesAtom, [makeInstance('browser-1'), makeInstance('browser-2')])
    store.set(integratedBrowserInstanceIdAtom, 'browser-1')

    store.set(removeBrowserInstanceAtom, 'browser-2')

    expect(store.get(integratedBrowserInstanceIdAtom)).toBe('browser-1')
  })
})
