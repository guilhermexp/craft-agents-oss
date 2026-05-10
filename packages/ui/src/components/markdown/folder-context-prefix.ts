/**
 * folder-context-prefix.ts — make agent-emitted file lists resolvable.
 *
 * Agents (Hermes/Claude/Pi) often answer with shapes like:
 *
 *   Pasta: /Users/foo/proj/mockups/
 *   - 00-overview.png
 *   - 01-dashboard.png
 *
 * The list items are bare basenames, so the renderer's path resolver can't
 * locate them and falls back to the session folder. This pre-processor scans
 * for `Pasta:` / `Folder:` / `Directory:` / `Diretório:` lines that point at
 * an absolute path, then rewrites following bullet-list basenames into
 * markdown links with the absolute path as the destination.
 *
 * Idempotent — items already wrapped in a markdown link, inside a fenced
 * code block, or whose folder marker is not absolute are left untouched.
 */

import { FILE_EXTENSIONS_PATTERN } from '../../lib/file-classification'

const FOLDER_LABEL_PATTERN =
  /(?:^|\n)[ \t]*(?:[*_]{1,2})?[ \t]*(Pasta|Folder|Directory|Diret[óo]rio)[ \t]*(?:[*_]{1,2})?[ \t]*[:：][ \t]*(?:\r?\n[ \t]*)?([^\n]+)/gi

const BASENAME_LIST_ITEM_PATTERN = new RegExp(
  `(^|\\n)([ \\t]*[-*+•][ \\t]+)(\`?)([\\w][\\w\\-. ]*?\\.(?:${FILE_EXTENSIONS_PATTERN}))\\3(?=[ \\t]*(?:\\r?\\n|$))`,
  'gi',
)

const FENCED_CODE_PATTERN = /```[\s\S]*?```/g

interface OffsetRange {
  start: number
  end: number
}

interface FolderMarker {
  offset: number
  folder: string
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(path)
}

function trimFolderValue(value: string): string {
  return value
    .trim()
    .replace(/^[`<"'(\[]+/, '')
    .replace(/[`>"')\].,;]+$/, '')
    .replace(/\/+$/, '')
}

function findFencedCodeRanges(text: string): OffsetRange[] {
  const ranges: OffsetRange[] = []
  FENCED_CODE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCED_CODE_PATTERN.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function inAnyRange(pos: number, ranges: OffsetRange[]): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end)
}

function collectFolderMarkers(text: string, codeRanges: OffsetRange[]): FolderMarker[] {
  const markers: FolderMarker[] = []
  FOLDER_LABEL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FOLDER_LABEL_PATTERN.exec(text)) !== null) {
    if (inAnyRange(match.index, codeRanges)) continue
    const folder = trimFolderValue(match[2] ?? '')
    if (!folder || !isAbsoluteLike(folder)) continue
    markers.push({ offset: match.index + match[0].length, folder })
  }
  return markers
}

function activeFolderAt(markers: FolderMarker[], pos: number): string | null {
  let current: string | null = null
  for (const marker of markers) {
    if (marker.offset <= pos) current = marker.folder
    else break
  }
  return current
}

function joinFolder(folder: string, basename: string): string {
  return `${folder.replace(/\/+$/, '')}/${basename}`
}

/**
 * Rewrites bullet-list basenames into absolute markdown links when an
 * upstream `Pasta:` / `Folder:` marker is in scope.
 *
 * Idempotent — safe to call repeatedly. Items that already include a slash,
 * are wrapped in a markdown link, or sit inside a fenced code block are
 * left untouched.
 */
export function prefixFolderContext(text: string): string {
  if (!text) return text
  if (!/(?:Pasta|Folder|Directory|Diret[óo]rio)\s*[:：]/i.test(text)) {
    return text
  }

  const codeRanges = findFencedCodeRanges(text)
  const markers = collectFolderMarkers(text, codeRanges)
  if (markers.length === 0) return text

  BASENAME_LIST_ITEM_PATTERN.lastIndex = 0
  return text.replace(BASENAME_LIST_ITEM_PATTERN, (...args) => {
    const full = args[0] as string
    const lineStart = args[1] as string
    const bullet = args[2] as string
    const tickWrap = args[3] as string
    const basename = args[4] as string
    const offset = args[args.length - 2] as number

    if (inAnyRange(offset, codeRanges)) return full
    const folder = activeFolderAt(markers, offset)
    if (!folder) return full
    if (basename.includes('/')) return full

    const absolute = joinFolder(folder, basename)
    const target = /\s/.test(absolute) ? `<${absolute}>` : absolute
    const display = tickWrap ? `\`${basename}\`` : basename
    return `${lineStart}${bullet}[${display}](${target})`
  })
}
