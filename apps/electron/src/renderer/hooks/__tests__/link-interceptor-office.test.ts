import { describe, it, expect } from 'bun:test'
import {
  officeLivePathToClose,
  shouldApplyOfficeLiveResult,
  type FilePreviewState,
} from '../useLinkInterceptor'

// Covers the two defects in the Office-preview path of useLinkInterceptor:
//   1. The live `officecli watch` server was never torn down on close/replace,
//      leaking an unauthenticated write-capable loopback HTTP server per doc.
//   2. A slow openOfficeLive could clobber a newer preview, and a close during
//      the await would reopen the overlay.
// This workspace has no DOM/renderHook harness (see useProjects.test.ts), so the
// load-bearing decisions live in exported pure helpers the hook wires verbatim;
// the scenarios below drive those helpers exactly as the hook sequences them.

describe('officeLivePathToClose', () => {
  it('returns the path of a live Office preview so closePreview can tear it down', () => {
    const state: FilePreviewState = { type: 'officeLive', filePath: '/docs/budget.xlsx', url: null }
    expect(officeLivePathToClose(state)).toBe('/docs/budget.xlsx')
  })

  it('still returns the path once the live server has resolved a url', () => {
    const state: FilePreviewState = { type: 'officeLive', filePath: '/docs/budget.xlsx', url: 'http://127.0.0.1:5321/' }
    expect(officeLivePathToClose(state)).toBe('/docs/budget.xlsx')
  })

  it('returns null for a non-Office preview so closeOfficeLive is not called', () => {
    const state: FilePreviewState = { type: 'code', filePath: '/src/index.ts', content: 'x', language: 'typescript' }
    expect(officeLivePathToClose(state)).toBeNull()
  })

  it('returns null when nothing is being previewed', () => {
    expect(officeLivePathToClose(null)).toBeNull()
  })
})

describe('Office live-server teardown side effects', () => {
  // Faithful mirror of the hook's closePreview / replace wiring: it asks
  // officeLivePathToClose which server (if any) to stop, then fires the
  // best-effort closeOfficeLive. Proves the RPC is/ isn't invoked per preview type.
  function teardownFor(outgoing: FilePreviewState | null, closeSpy: (path: string) => void): void {
    const path = officeLivePathToClose(outgoing)
    if (path) closeSpy(path)
  }

  it('closing an Office preview calls closeOfficeLive with its path', () => {
    const calls: string[] = []
    teardownFor({ type: 'officeLive', filePath: '/a.xlsx', url: 'http://127.0.0.1:1/' }, (p) => calls.push(p))
    expect(calls).toEqual(['/a.xlsx'])
  })

  it('closing a preview of another type does not call closeOfficeLive', () => {
    const calls: string[] = []
    teardownFor({ type: 'pdf', filePath: '/a.pdf' }, (p) => calls.push(p))
    expect(calls).toEqual([])
  })

  it('replacing Office A with a different file tears down A', () => {
    const previous: FilePreviewState = { type: 'officeLive', filePath: '/a.xlsx', url: 'http://127.0.0.1:1/' }
    const nextPath = '/b.docx'
    const superseded = officeLivePathToClose(previous)
    // Mirrors the hook guard: close only when the incoming file differs.
    expect(superseded && superseded !== nextPath ? superseded : null).toBe('/a.xlsx')
  })

  it('reopening the same Office path does not tear it down (openOfficeLive reuses it)', () => {
    const previous: FilePreviewState = { type: 'officeLive', filePath: '/a.xlsx', url: 'http://127.0.0.1:1/' }
    const nextPath = '/a.xlsx'
    const superseded = officeLivePathToClose(previous)
    expect(superseded && superseded !== nextPath ? superseded : null).toBeNull()
  })
})

describe('shouldApplyOfficeLiveResult (generation guard)', () => {
  it('applies a result when its request is still the newest', () => {
    expect(shouldApplyOfficeLiveResult(2, 2)).toBe(true)
  })

  it('drops a result whose request was superseded', () => {
    expect(shouldApplyOfficeLiveResult(1, 2)).toBe(false)
  })

  // Each open and each close bumps the monotonic generation, exactly as the
  // hook does. These sequences reproduce the acceptance scenarios end-to-end.
  it('opening A (slow) then B keeps B: A resolves stale, B resolves current', () => {
    let generation = 0
    const genA = ++generation // handleOpenFile('/a.xlsx')
    const genB = ++generation // handleOpenFile('/b.docx')
    // A finally resolves after B was requested.
    expect(shouldApplyOfficeLiveResult(genA, generation)).toBe(false)
    // B resolves last.
    expect(shouldApplyOfficeLiveResult(genB, generation)).toBe(true)
  })

  it('closePreview during A\'s await prevents A from reopening the overlay', () => {
    let generation = 0
    const genA = ++generation // handleOpenFile('/a.xlsx')
    ++generation              // closePreview() bumps the generation
    expect(shouldApplyOfficeLiveResult(genA, generation)).toBe(false)
  })

  it('a stale openOfficeLive rejection does not overwrite the current preview', () => {
    let generation = 0
    const genA = ++generation // handleOpenFile('/a.xlsx')
    ++generation              // handleOpenFile('/b.docx') supersedes A
    // A rejects late; the catch branch must bail on the same guard.
    expect(shouldApplyOfficeLiveResult(genA, generation)).toBe(false)
  })
})
