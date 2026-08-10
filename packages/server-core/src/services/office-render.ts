/**
 * Office document rendering via the bundled OfficeCLI binary.
 *
 * Turns .docx/.xlsx/.pptx into self-contained HTML so the renderer can display
 * them with the same sandboxed-iframe path it already uses for HTML previews.
 * Without this, those formats have no in-app preview at all — they route to the
 * system opener.
 *
 * The binary ships in resources/bin/{platform}-{arch}/ next to uv, provisioned
 * by downloadOfficeCli() at build time.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Formats OfficeCLI can render. Keep in sync with file-classification.ts.
 *
 * Deliberately narrow: the binary accepts exactly these three and rejects every
 * other extension outright — including macro/template variants (.xlsm, .xltx,
 * .docm), legacy OLE2 formats (.doc, .xls, .ppt) and .ods/.csv. Widening this
 * set would route files here only for the render to fail.
 */
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx'])

/** Rendering a large deck is slow but bounded; never hang the panel forever. */
const RENDER_TIMEOUT_MS = 30_000

/**
 * Cap on captured stdout. A rendered document is self-contained HTML with
 * inlined CSS and base64 images, so it can be large — but not unbounded.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Rendering is deterministic per file revision, so results are worth keeping. */
const CACHE_MAX_ENTRIES = 12

interface CacheEntry {
  html: string
  mtimeMs: number
  size: number
}

const renderCache = new Map<string, CacheEntry>()

export function isOfficeRenderableFile(filePath: string): boolean {
  const basename = filePath.split(/[/\\]/).pop() ?? filePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) return false
  return OFFICE_EXTENSIONS.has(basename.slice(dotIndex + 1).toLowerCase())
}

function getPlatformRuntimeDir(): string {
  return `${process.platform}-${process.arch}`
}

function getProcessResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the OfficeCLI binary.
 *
 * Order mirrors resolveScriptRuntime(): explicit env override, then the bundled
 * binary, then PATH — the last one only helps in dev, where resources/bin may
 * not be provisioned yet.
 */
export function resolveOfficeCliPath(): string | null {
  const override = process.env.CRAFT_OFFICECLI
  if (override) {
    const resolved = isAbsolute(override) ? override : resolve(override)
    return existsSync(resolved) ? resolved : null
  }

  const binary = process.platform === 'win32' ? 'officecli.exe' : 'officecli'
  const platformDir = getPlatformRuntimeDir()

  const resourcesBase = process.env.CRAFT_RESOURCES_BASE
    ? resolve(process.env.CRAFT_RESOURCES_BASE)
    : null
  const appRoot = process.env.CRAFT_APP_ROOT ? resolve(process.env.CRAFT_APP_ROOT) : null
  const resourcesPath = getProcessResourcesPath()

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'resources', 'bin', platformDir, binary) : '',
    appRoot ? join(appRoot, 'resources', 'bin', platformDir, binary) : '',
    resourcesPath ? join(resourcesPath, 'app', 'resources', 'bin', platformDir, binary) : '',
  ])
}

function cacheGet(filePath: string, mtimeMs: number, size: number): string | null {
  const entry = renderCache.get(filePath)
  if (!entry) return null
  // A same-path file that changed on disk must re-render, not serve the old HTML.
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
    renderCache.delete(filePath)
    return null
  }
  // Refresh LRU position.
  renderCache.delete(filePath)
  renderCache.set(filePath, entry)
  return entry.html
}

function cacheSet(filePath: string, html: string, mtimeMs: number, size: number): void {
  renderCache.delete(filePath)
  renderCache.set(filePath, { html, mtimeMs, size })
  while (renderCache.size > CACHE_MAX_ENTRIES) {
    const oldest = renderCache.keys().next().value
    if (oldest === undefined) break
    renderCache.delete(oldest)
  }
}

/** Drop cached renders for a file (or all files when omitted). */
export function invalidateOfficeRenderCache(filePath?: string): void {
  if (filePath) renderCache.delete(filePath)
  else renderCache.clear()
}

/**
 * Document paths OfficeCLI accepts, of the form `/<sheetName>/<A1Ref>`.
 *
 * The renderer echoes back a path the render itself emitted, but it arrives
 * over IPC, so it is validated rather than trusted: it becomes a CLI argument,
 * and a path containing a newline or shell-ish payload has no business here.
 * Sheet names may contain spaces and accents but not `/`, `\` or quotes.
 */
const CELL_PATH_PATTERN = /^\/[^/\\"'\n\r]{1,255}\/\$?[A-Za-z]{1,3}\$?\d{1,7}$/

export function isValidCellPath(cellPath: string): boolean {
  return CELL_PATH_PATTERN.test(cellPath)
}

export class OfficeCliUnavailableError extends Error {
  constructor() {
    super(
      'OfficeCLI binary not found. It ships in resources/bin/{platform}-{arch}/ — ' +
      'run the dev bootstrap or set CRAFT_OFFICECLI to an absolute path.'
    )
    this.name = 'OfficeCliUnavailableError'
  }
}

/**
 * Render an Office document to self-contained HTML.
 *
 * @param filePath Absolute path to an already-validated file.
 * @returns The rendered HTML.
 */
export async function renderOfficeToHtml(filePath: string): Promise<string> {
  if (!isOfficeRenderableFile(filePath)) {
    throw new Error(`Not an Office document OfficeCLI can render: ${filePath}`)
  }

  const officeCliPath = resolveOfficeCliPath()
  if (!officeCliPath) throw new OfficeCliUnavailableError()

  const stats = await stat(filePath)
  const cached = cacheGet(filePath, stats.mtimeMs, stats.size)
  if (cached) return cached

  try {
    const { stdout } = await execFileAsync(
      officeCliPath,
      ['view', filePath, 'html'],
      {
        timeout: RENDER_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      }
    )

    if (!stdout.trim()) {
      throw new Error('OfficeCLI produced no output')
    }

    cacheSet(filePath, stdout, stats.mtimeMs, stats.size)
    return stdout
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    if (err.killed) {
      throw new Error(`Rendering timed out after ${RENDER_TIMEOUT_MS / 1000}s`)
    }
    const detail = err.stderr?.trim() || err.message
    throw new Error(`OfficeCLI failed to render: ${detail}`)
  }
}

/**
 * Write a single cell value back to a spreadsheet.
 *
 * Goes through OfficeCLI rather than a JS xlsx writer because it edits the
 * existing package in place: formulas, number formats, styling, frozen panes,
 * charts and other sheets all survive, where a rewrite-the-workbook approach
 * would drop whatever its object model doesn't cover.
 *
 * @param filePath Absolute path to an already-validated .xlsx file.
 * @param cellPath OfficeCLI document path, e.g. "/Sheet1/B4".
 * @param value Literal cell value, or a formula when prefixed with "=".
 */
export async function setOfficeCellValue(
  filePath: string,
  cellPath: string,
  value: string,
): Promise<void> {
  if (!isOfficeRenderableFile(filePath)) {
    throw new Error(`Not an editable Office document: ${filePath}`)
  }
  if (!isValidCellPath(cellPath)) {
    throw new Error(`Invalid cell path: ${cellPath}`)
  }

  const officeCliPath = resolveOfficeCliPath()
  if (!officeCliPath) throw new OfficeCliUnavailableError()

  // A leading "=" means the user typed a formula; OfficeCLI wants it without
  // the "=" under the `formula` prop rather than as a literal value.
  const prop = value.startsWith('=')
    ? `formula=${value.slice(1)}`
    : `value=${value}`

  const runCli = (args: string[]) => execFileAsync(officeCliPath, args, {
    timeout: RENDER_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })

  try {
    await runCli(['set', filePath, cellPath, '--prop', prop])
    // `set` alone only applies the change in memory when a resident process is
    // holding the document — it reports success while the file on disk is
    // untouched. `save` flushes it, and is a no-op when no resident is running.
    await runCli(['save', filePath])
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    if (err.killed) throw new Error(`Edit timed out after ${RENDER_TIMEOUT_MS / 1000}s`)
    throw new Error(`OfficeCLI failed to write cell: ${err.stderr?.trim() || err.message}`)
  }

  // The file changed, so the cached render is stale. mtime/size checks would
  // usually catch this, but dropping it explicitly avoids depending on
  // filesystem timestamp granularity for an edit we know just happened.
  invalidateOfficeRenderCache(filePath)
}
