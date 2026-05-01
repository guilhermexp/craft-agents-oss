import { isFilePathTarget } from './linkify'

export type ResolvedMarkdownLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

function normalizeFileUrlPath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
}

function resolveFileUrlPath(target: string): string | null {
  if (!/^file:/i.test(target)) return null

  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'file:') return null

    const pathname = decodeURIComponent(parsed.pathname || '')
    if (!pathname && !parsed.hostname) return null

    if (parsed.hostname) {
      const hostname = decodeURIComponent(parsed.hostname)
      return normalizeFileUrlPath(`//${hostname}${pathname}`)
    }

    return normalizeFileUrlPath(pathname)
  } catch {
    return null
  }
}

function stripTargetDelimiters(target: string): string {
  const trimmed = target.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '<' && last === '>')
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function decodeEscapedUnicodeSequences(target: string): string {
  return target
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (match, codePoint: string) => {
      const value = Number.parseInt(codePoint, 16)
      if (!Number.isFinite(value)) return match
      try {
        return String.fromCodePoint(value)
      } catch {
        return match
      }
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, codePoint: string) => {
      const value = Number.parseInt(codePoint, 16)
      if (!Number.isFinite(value)) return match
      try {
        return String.fromCharCode(value)
      } catch {
        return match
      }
    })
}

/**
 * Resolve markdown link targets for click dispatch.
 *
 * - Raw filesystem paths are routed through onFileClick
 * - Explicit file:// URLs are normalized to filesystem paths and also routed through onFileClick
 * - Everything else is treated as a URL and routed through onUrlClick
 */
export function resolveMarkdownLinkTarget(target: string): ResolvedMarkdownLinkTarget {
  const trimmed = decodeEscapedUnicodeSequences(stripTargetDelimiters(target))

  const fileUrlPath = resolveFileUrlPath(trimmed)
  if (fileUrlPath) {
    return { kind: 'file', path: fileUrlPath }
  }

  if (isFilePathTarget(trimmed)) {
    return { kind: 'file', path: trimmed }
  }

  return { kind: 'url', url: trimmed }
}

/**
 * Backward-compatible classifier for tests and existing callers that only need the kind.
 */
export function classifyMarkdownLinkTarget(target: string): 'file' | 'url' {
  return resolveMarkdownLinkTarget(target).kind
}
