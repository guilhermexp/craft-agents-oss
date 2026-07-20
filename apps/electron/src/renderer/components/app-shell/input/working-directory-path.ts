import { PATH_SEP } from '@/lib/platform'

function isHomePath(path: string, homeDir: string): boolean {
  if (!homeDir) return false
  const homePrefix = homeDir.endsWith(PATH_SEP) ? homeDir : `${homeDir}${PATH_SEP}`
  return path === homeDir || path.startsWith(homePrefix)
}

/** Desktop display format, including the contextual "in" prefix. */
export function formatPathForDisplay(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  let displayPath = path
  if (isHomePath(path, homeDir)) {
    const relativePath = path.slice(homeDir.length)
    displayPath = relativePath.startsWith(PATH_SEP)
      ? relativePath.slice(1)
      : (relativePath || PATH_SEP)
  }
  return `in ${displayPath}`
}

/** Compact row format, shortening the home directory to a tilde. */
export function formatCompactPath(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  if (isHomePath(path, homeDir)) {
    const relativePath = path.slice(homeDir.length)
    if (!relativePath || relativePath === PATH_SEP) return '~'
    return `~${relativePath.startsWith(PATH_SEP) ? relativePath : `${PATH_SEP}${relativePath}`}`
  }
  return path
}
