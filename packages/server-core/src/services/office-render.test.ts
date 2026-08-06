import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import {
  isOfficeRenderableFile,
  resolveOfficeCliPath,
  renderOfficeToHtml,
  isValidCellPath,
  setOfficeCellValue,
} from './office-render'

describe('isOfficeRenderableFile', () => {
  it('accepts exactly the three formats OfficeCLI supports', () => {
    expect(isOfficeRenderableFile('/tmp/budget.xlsx')).toBe(true)
    expect(isOfficeRenderableFile('/tmp/report.docx')).toBe(true)
    expect(isOfficeRenderableFile('/tmp/deck.pptx')).toBe(true)
  })

  it('rejects variants the binary refuses, so they never reach the render path', () => {
    for (const path of [
      '/tmp/macro.xlsm', '/tmp/template.xltx', '/tmp/macro.docm',
      '/tmp/legacy.doc', '/tmp/legacy.xls', '/tmp/legacy.ppt',
      '/tmp/open.ods', '/tmp/data.csv', '/tmp/notes.txt',
    ]) {
      expect(isOfficeRenderableFile(path)).toBe(false)
    }
  })

  it('matches case-insensitively and ignores paths without an extension', () => {
    expect(isOfficeRenderableFile('/tmp/BUDGET.XLSX')).toBe(true)
    expect(isOfficeRenderableFile('/tmp/Makefile')).toBe(false)
    expect(isOfficeRenderableFile('/tmp/.hidden')).toBe(false)
  })

  it('reads the extension from the basename, not from a dotted directory', () => {
    expect(isOfficeRenderableFile('/tmp/v1.2.3/report')).toBe(false)
    expect(isOfficeRenderableFile('/tmp/v1.2.3/report.docx')).toBe(true)
  })
})

describe('renderOfficeToHtml', () => {
  it('refuses unsupported extensions before spawning anything', async () => {
    await expect(renderOfficeToHtml('/tmp/notes.txt')).rejects.toThrow(/Not an Office document/)
  })
})

describe('isValidCellPath', () => {
  it('accepts the paths the render emits', () => {
    expect(isValidCellPath('/Sheet1/A1')).toBe(true)
    expect(isValidCellPath('/Vendas 2026/C2')).toBe(true)
    expect(isValidCellPath('/Sheet1/AB1234')).toBe(true)
    expect(isValidCellPath('/Sheet1/$B$4')).toBe(true)
  })

  it('rejects anything that could smuggle payload into a CLI argument', () => {
    // The path round-trips through the renderer, so it is attacker-influenced
    // input by the time it comes back over IPC.
    for (const bad of [
      '/Sheet1/A1; rm -rf /',
      '/Sheet1/A1\nset other',
      '/Sheet1/A1\r',
      '../../etc/passwd',
      '/Sheet"1/A1',
      "/Sheet'1/A1",
      '/Sheet\\1/A1',
      '/Sheet1/A',
      '/Sheet1/1',
      '/Sheet1/ABCD1',
      'Sheet1/A1',
      '',
    ]) {
      expect(isValidCellPath(bad)).toBe(false)
    }
  })
})

describe('setOfficeCellValue', () => {
  it('rejects non-spreadsheet targets before spawning anything', async () => {
    await expect(setOfficeCellValue('/tmp/notes.txt', '/Sheet1/A1', '1'))
      .rejects.toThrow(/Not an editable Office document/)
  })

  it('rejects a malformed cell path before spawning anything', async () => {
    await expect(setOfficeCellValue('/tmp/book.xlsx', '/Sheet1/A1; whoami', '1'))
      .rejects.toThrow(/Invalid cell path/)
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
