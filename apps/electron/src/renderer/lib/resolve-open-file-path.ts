interface FileSearchResultLike {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

export interface ResolveOpenFilePathOptions {
  path: string
  baseDirs: Array<string | null | undefined>
  sessionId?: string | null
  searchFiles: (basePath: string, query: string) => Promise<FileSearchResultLike[]>
}

export interface ResolvedOpenFilePath {
  path: string
  fallbackPath?: string
}

function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(path)
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

function cleanRelativePath(path: string): string {
  return trimSlashes(path.replace(/^\.\//, ''))
}

function joinPath(baseDir: string, relativePath: string): string {
  return `${baseDir.replace(/\/+$/, '')}/${cleanRelativePath(relativePath)}`
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function parentDir(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return null
  return normalized.slice(0, index)
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)))
}

function buildCandidatePaths(path: string, baseDirs: string[], sessionId?: string | null): string[] {
  const cleaned = cleanRelativePath(path)
  const candidates: string[] = []

  if (isAbsoluteLikePath(path)) {
    candidates.push(path)
  } else {
    for (const baseDir of baseDirs) {
      candidates.push(joinPath(baseDir, cleaned))

      if (sessionId && cleaned.startsWith(`${sessionId}/`)) {
        candidates.push(joinPath(baseDir, cleaned.slice(sessionId.length + 1)))
      }
    }
  }

  return Array.from(new Set(candidates))
}

async function findExistingCandidate(
  candidates: string[],
  searchFiles: ResolveOpenFilePathOptions['searchFiles']
): Promise<string | null> {
  const fileName = candidates.length > 0 ? basename(candidates[0]) : ''
  if (!fileName) return null

  for (const candidate of candidates) {
    const dir = parentDir(candidate)
    if (!dir) continue

    try {
      const matches = await searchFiles(dir, fileName)
      const exact = matches.find((match) => match.type === 'file' && match.path === candidate)
      if (exact) return exact.path
    } catch {
      // Best-effort path validation; continue through remaining candidates.
    }
  }

  return null
}

async function findByBasename(
  fileName: string,
  baseDirs: string[],
  preferredRelativePath: string,
  searchFiles: ResolveOpenFilePathOptions['searchFiles']
): Promise<string | null> {
  const matches: FileSearchResultLike[] = []

  for (const baseDir of baseDirs) {
    try {
      const baseMatches = await searchFiles(baseDir, fileName)
      matches.push(...baseMatches.filter((match) => match.type === 'file' && match.name === fileName))
    } catch {
      // Search fallback is best-effort.
    }
  }

  const uniqueMatches = Array.from(new Map(matches.map((match) => [match.path, match])).values())
  if (uniqueMatches.length === 0) return null

  const cleanedPreferred = cleanRelativePath(preferredRelativePath)
  const exactRelative = uniqueMatches.find((match) => cleanRelativePath(match.relativePath) === cleanedPreferred)
  if (exactRelative) return exactRelative.path

  const suffix = `/${cleanedPreferred}`
  const suffixMatch = uniqueMatches.find((match) => match.path.endsWith(suffix))
  if (suffixMatch) return suffixMatch.path

  return uniqueMatches.length === 1 ? uniqueMatches[0].path : null
}

export async function resolveOpenFilePath({
  path,
  baseDirs,
  sessionId,
  searchFiles,
}: ResolveOpenFilePathOptions): Promise<ResolvedOpenFilePath> {
  const normalizedBaseDirs = uniqueNonEmpty(baseDirs)
  const candidates = buildCandidatePaths(path, normalizedBaseDirs, sessionId)
  const primaryPath = candidates[0] ?? path

  const existingCandidate = await findExistingCandidate(candidates, searchFiles)
  if (existingCandidate) {
    return { path: existingCandidate, fallbackPath: existingCandidate === primaryPath ? undefined : existingCandidate }
  }

  const fileName = basename(path)
  if (fileName && normalizedBaseDirs.length > 0) {
    const basenameMatch = await findByBasename(fileName, normalizedBaseDirs, path, searchFiles)
    if (basenameMatch) {
      return { path: basenameMatch, fallbackPath: basenameMatch === primaryPath ? undefined : basenameMatch }
    }
  }

  return { path: primaryPath }
}
