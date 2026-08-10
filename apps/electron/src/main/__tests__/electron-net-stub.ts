/**
 * Minimal `electron.net` stand-in for suites that mock `electron` but do not
 * exercise favicon fetching.
 *
 * `createFaviconFetcher` in `browser-pane-manager.ts` wraps `net.request` in a
 * promise that settles only from a `response`, `error` or `abort` listener. A
 * no-op `request.on` therefore leaves that promise pending forever, and because
 * Bun's `mock.module` registry is global and last-registration-wins, one suite's
 * inert `net` mock can hang an unrelated suite in the same run. This stub fails
 * the request instead — the honest behavior for a test with no network — so the
 * promise always settles.
 */

type Listener = (...args: unknown[]) => void

export function createInertNetStub(): { request: () => unknown } {
  return {
    request: () => {
      const listeners = new Map<string, Listener>()
      return {
        on(event: string, listener: Listener) {
          listeners.set(event, listener)
          return this
        },
        end() {
          queueMicrotask(() => {
            listeners.get('error')?.(new Error('net.request is stubbed in tests'))
          })
        },
        abort() {
          listeners.get('abort')?.()
        },
        followRedirect() {},
      }
    },
  }
}
