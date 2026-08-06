import { describe, expect, it, afterEach } from 'bun:test'
import {
  openOfficeLiveServer,
  closeOfficeLiveServer,
  shutdownOfficeLiveServers,
  listOfficeLiveServers,
} from './office-live'

afterEach(() => {
  shutdownOfficeLiveServers()
})

describe('openOfficeLiveServer', () => {
  it('refuses file types the binary cannot serve, before spawning anything', async () => {
    for (const path of ['/tmp/notes.txt', '/tmp/data.csv', '/tmp/legacy.xls', '/tmp/macro.xlsm']) {
      await expect(openOfficeLiveServer(path)).rejects.toThrow(/Not a live-editable Office document/)
    }
  })

  it('starts with no servers running', () => {
    expect(listOfficeLiveServers()).toEqual([])
  })
})

describe('closeOfficeLiveServer', () => {
  it('is a no-op for a file with no server', () => {
    // Panel teardown fires on every file change, including ones that never
    // opened a server — it must not throw.
    expect(() => closeOfficeLiveServer('/tmp/never-opened.xlsx')).not.toThrow()
  })
})

describe('shutdownOfficeLiveServers', () => {
  it('is safe to call when nothing is running', () => {
    expect(() => shutdownOfficeLiveServers()).not.toThrow()
    expect(listOfficeLiveServers()).toEqual([])
  })
})
