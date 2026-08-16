/**
 * OfficeCLI binary resolution, and the format gate that decides when it applies.
 *
 * .docx/.xlsx/.pptx have no in-app surface without OfficeCLI — they route to the
 * system opener. `office-live.ts` is the only consumer: it serves those formats
 * from `officecli watch`, which needs the binary's absolute path plus the same
 * narrow extension gate. Both live here so nothing else in the app has to know
 * where the binary ships.
 *
 * The binary ships in resources/bin/{platform}-{arch}/ next to uv, provisioned
 * by downloadOfficeCli() at build time.
 */

import { existsSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

/**
 * Formats OfficeCLI can open. Keep in sync with file-classification.ts.
 *
 * Deliberately narrow: the binary accepts exactly these three and rejects every
 * other extension outright — including macro/template variants (.xlsm, .xltx,
 * .docm), legacy OLE2 formats (.doc, .xls, .ppt) and .ods/.csv. Widening this
 * set would route files here only for the open to fail.
 */
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx'])

export function isOfficeDocumentFile(filePath: string): boolean {
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

export class OfficeCliUnavailableError extends Error {
  constructor() {
    super(
      'OfficeCLI binary not found. It ships in resources/bin/{platform}-{arch}/ — ' +
      'run the dev bootstrap or set CRAFT_OFFICECLI to an absolute path.'
    )
    this.name = 'OfficeCliUnavailableError'
  }
}
