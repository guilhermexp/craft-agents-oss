import { describe, test, expect } from 'bun:test'
import { getAllNamespaceValues, RPC_NAMESPACES } from '../channels'
import { LOCAL_ONLY_NAMESPACES, REMOTE_ELIGIBLE_NAMESPACES } from '../routing'

describe('channel routing exhaustiveness', () => {
  const all = getAllNamespaceValues()

  test('every channel is classified exactly once', () => {
    for (const ch of all) {
      const inLocal = LOCAL_ONLY_NAMESPACES.has(ch)
      const inRemote = REMOTE_ELIGIBLE_NAMESPACES.has(ch)

      if (!inLocal && !inRemote) {
        throw new Error(`Channel "${ch}" is not classified in LOCAL_ONLY or REMOTE_ELIGIBLE. Add it to one set in routing.ts.`)
      }
      if (inLocal && inRemote) {
        throw new Error(`Channel "${ch}" is in BOTH LOCAL_ONLY and REMOTE_ELIGIBLE. It must be in exactly one.`)
      }
    }
  })

  test('no extra channels in LOCAL_ONLY', () => {
    for (const ch of LOCAL_ONLY_NAMESPACES) {
      expect(all).toContain(ch)
    }
  })

  test('no extra channels in REMOTE_ELIGIBLE', () => {
    for (const ch of REMOTE_ELIGIBLE_NAMESPACES) {
      expect(all).toContain(ch)
    }
  })

  test('sets are non-empty', () => {
    expect(LOCAL_ONLY_NAMESPACES.size).toBeGreaterThan(0)
    expect(REMOTE_ELIGIBLE_NAMESPACES.size).toBeGreaterThan(0)
  })

  test('total classified equals total channels', () => {
    expect(LOCAL_ONLY_NAMESPACES.size + REMOTE_ELIGIBLE_NAMESPACES.size).toBe(all.length)
  })
})

describe('channel routing behavior', () => {
  test('LOCAL_ONLY and REMOTE_ELIGIBLE have zero intersection', () => {
    const intersection: string[] = []
    for (const ch of LOCAL_ONLY_NAMESPACES) {
      if (REMOTE_ELIGIBLE_NAMESPACES.has(ch)) {
        intersection.push(ch)
      }
    }
    expect(intersection).toEqual([])
  })

  test('all server:* channels are REMOTE_ELIGIBLE', () => {
    const serverChannels = Object.values(RPC_NAMESPACES.server)
    expect(serverChannels.length).toBeGreaterThan(0)

    for (const ch of serverChannels) {
      expect(REMOTE_ELIGIBLE_NAMESPACES.has(ch)).toBe(true)
    }
  })

  test('no LOCAL_ONLY channel starts with server:', () => {
    for (const ch of LOCAL_ONLY_NAMESPACES) {
      if (ch.startsWith('server:')) {
        throw new Error(`server:* channel "${ch}" must be REMOTE_ELIGIBLE, not LOCAL_ONLY`)
      }
    }
  })

  test('browserPane.importCookies is LOCAL_ONLY, like its profile siblings', () => {
    // The reader touches the local macOS Keychain plus the local Chrome cookie
    // DB and writes into a local Electron partition. An unclassified channel
    // falls through isLocalOnly() to the workspaceClient, which would run the
    // import against a REMOTE host's cookie jar.
    expect(LOCAL_ONLY_NAMESPACES.has(RPC_NAMESPACES.browserPane.IMPORT_COOKIES)).toBe(true)
    expect(REMOTE_ELIGIBLE_NAMESPACES.has(RPC_NAMESPACES.browserPane.IMPORT_COOKIES)).toBe(false)
  })

  test('every browserPane channel is LOCAL_ONLY', () => {
    for (const ch of Object.values(RPC_NAMESPACES.browserPane)) {
      expect({ channel: ch, local: LOCAL_ONLY_NAMESPACES.has(ch) })
        .toEqual({ channel: ch, local: true })
    }
  })
})
