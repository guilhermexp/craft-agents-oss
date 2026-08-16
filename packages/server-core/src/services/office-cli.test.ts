import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import {
  isOfficeDocumentFile,
  resolveOfficeCliPath,
} from './office-cli'

describe('isOfficeDocumentFile', () => {
  it('accepts exactly the three formats OfficeCLI supports', () => {
    expect(isOfficeDocumentFile('/tmp/budget.xlsx')).toBe(true)
    expect(isOfficeDocumentFile('/tmp/report.docx')).toBe(true)
    expect(isOfficeDocumentFile('/tmp/deck.pptx')).toBe(true)
  })

  it('rejects variants the binary refuses, so they never reach the live path', () => {
    for (const path of [
      '/tmp/macro.xlsm', '/tmp/template.xltx', '/tmp/macro.docm',
      '/tmp/legacy.doc', '/tmp/legacy.xls', '/tmp/legacy.ppt',
      '/tmp/open.ods', '/tmp/data.csv', '/tmp/notes.txt',
    ]) {
      expect(isOfficeDocumentFile(path)).toBe(false)
    }
  })

  it('matches case-insensitively and ignores paths without an extension', () => {
    expect(isOfficeDocumentFile('/tmp/BUDGET.XLSX')).toBe(true)
    expect(isOfficeDocumentFile('/tmp/Makefile')).toBe(false)
    expect(isOfficeDocumentFile('/tmp/.hidden')).toBe(false)
  })

  it('reads the extension from the basename, not from a dotted directory', () => {
    expect(isOfficeDocumentFile('/tmp/v1.2.3/report')).toBe(false)
    expect(isOfficeDocumentFile('/tmp/v1.2.3/report.docx')).toBe(true)
  })
})

describe('resolveOfficeCliPath', () => {
  const originalOverride = process.env.CRAFT_OFFICECLI

  beforeEach(() => {
    delete process.env.CRAFT_OFFICECLI
  })

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.CRAFT_OFFICECLI
    else process.env.CRAFT_OFFICECLI = originalOverride
  })

  it('returns null for an override pointing at a missing file', () => {
    // A stale CRAFT_OFFICECLI must not be handed to execFile — surfacing the
    // "binary not found" error beats spawning a nonexistent path.
    process.env.CRAFT_OFFICECLI = '/nonexistent/officecli'
    expect(resolveOfficeCliPath()).toBeNull()
  })

  it('honours an override that does exist', () => {
    process.env.CRAFT_OFFICECLI = process.execPath
    expect(resolveOfficeCliPath()).toBe(process.execPath)
  })
})
