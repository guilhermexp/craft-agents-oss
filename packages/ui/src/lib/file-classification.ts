/**
 * File type classification for the link interceptor.
 *
 * Classifies file paths by extension to determine whether the app can show
 * an in-app preview overlay, and if so, which type of preview to use.
 * Used by useLinkInterceptor to decide between in-app preview vs. opening externally.
 */

/** Preview types that map to specific overlay components */
export type FilePreviewType =
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'markdown'
  | 'json'
  | 'text'
  | 'pdf'
  | 'excalidraw'
  | 'spreadsheet'
  | 'richDocument'
  | 'presentation'
  | 'html'

/** Office types rendered to HTML by the bundled OfficeCLI binary. */
export const OFFICE_PREVIEW_TYPES = new Set<FilePreviewType>([
  'spreadsheet',
  'richDocument',
  'presentation',
])

export function isOfficePreviewType(type: FilePreviewType | null): boolean {
  return type !== null && OFFICE_PREVIEW_TYPES.has(type)
}

export interface FileClassification {
  /** The preview type, or null if no in-app preview is available */
  type: FilePreviewType | null
  /** Whether the file can be previewed in-app */
  canPreview: boolean
}

/**
 * Image formats — rendered in ImagePreviewOverlay via data URL.
 * Only includes formats Chromium can natively decode.
 * HEIC/HEIF and TIFF are excluded — Chromium has no codec for these,
 * so they fall through to system open (external app).
 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])

/** Audio formats — rendered in AudioPreviewOverlay with native Chromium playback. */
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac',
])

/**
 * Code file extensions — rendered in CodePreviewOverlay with syntax highlighting.
 * Mirrors LANGUAGE_MAP from file-utils.ts but as a flat set for classification only.
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less',
  'html', 'htm', 'xml', 'svg',  // SVG is also code-viewable, but image takes priority
  'yaml', 'yml', 'toml',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql',
  'dockerfile',
  'makefile',
  'r', 'lua', 'perl', 'php',
  'vue', 'svelte', 'astro', 'prisma',
])

/** Markdown files — rendered with the Markdown component */
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx'])

/** JSON files — rendered in JSONPreviewOverlay or code viewer */
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

/** Plain text files — rendered as plaintext in code viewer */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv',
  'cfg', 'ini', 'conf',
  'env', 'env.local', 'env.development', 'env.production',
  'gitignore', 'gitattributes', 'editorconfig',
  'npmrc', 'nvmrc',
  'rtf',
])

/** PDF files — rendered in PDFPreviewOverlay via embedded viewer */
const PDF_EXTENSIONS = new Set(['pdf'])

/**
 * Video formats — rendered with a native <video> element.
 * Only formats Chromium can decode; .avi/.mkv stay external.
 */
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])

/**
 * Office formats rendered to HTML by the bundled OfficeCLI binary.
 *
 * Exactly the three OpenXML formats the binary accepts — it rejects macro and
 * template variants (.xlsm, .xltx, .docm) and legacy OLE2 formats (.doc, .xls,
 * .ppt), which stay in EXTERNAL_EXTENSIONS so they route to the system opener.
 */
const SPREADSHEET_EXTENSIONS = new Set(['xlsx'])
const RICH_DOCUMENT_EXTENSIONS = new Set(['docx'])
const PRESENTATION_EXTENSIONS = new Set(['pptx'])

/** HTML documents — rendered as a page in a sandboxed iframe, never as code. */
const HTML_EXTENSIONS = new Set(['html', 'htm'])

/** Excalidraw files — rendered in ExcalidrawPreviewOverlay. */
const EXCALIDRAW_EXTENSIONS = new Set(['excalidraw'])

/**
 * External-only file extensions — recognized as file links but opened externally.
 * These are included in FILE_EXTENSIONS_PATTERN so linkify.ts detects them as file paths,
 * but classifyFile() returns canPreview: false so they route to the system opener.
 */
const EXTERNAL_EXTENSIONS = new Set([
  'xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'ods',  // Spreadsheets OfficeCLI rejects
  'doc', 'docm', 'dotx', 'odt',                  // Word documents OfficeCLI rejects
  'ppt', 'pptm', 'potx', 'odp',                  // Presentations OfficeCLI rejects
  'numbers', 'pages', 'key',        // Apple iWork — no in-app renderer
  'zip', 'tar', 'gz', 'rar', '7z',  // Archives
  'dmg', 'pkg', 'exe', 'msi',       // Installers
  'avi', 'mkv',                     // Video Chromium can't decode
  'heic', 'heif', 'tiff', 'tif',    // Images Chromium can't decode
])

/**
 * Extract the file extension from a path, lowercased.
 * Handles compound extensions like .env.local by returning the last segment.
 */
function getExtension(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === 0) return ''
  return basename.slice(dotIndex + 1).toLowerCase()
}

/**
 * Classify a file path by extension to determine preview capability.
 *
 * Routed in a fixed priority order — the first match wins. Order matters where
 * an extension belongs to more than one set:
 *
 *   1. office      xlsx/docx/pptx, rendered to HTML by OfficeCLI
 *   2. html        before code, so a page renders as a page and never as source
 *   3. media       image/audio/video/pdf; puts .svg on the image path, not code
 *   4. excalidraw  before json, since .excalidraw files are JSON underneath
 *   5. markdown
 *   6. json
 *   7. code
 *   8. text        the plain-text fallback
 */
export function classifyFile(filePath: string): FileClassification {
  if (filePath.toLowerCase().endsWith('.excalidraw.md')) {
    return { type: 'excalidraw', canPreview: true }
  }

  const ext = getExtension(filePath)
  if (!ext) return { type: null, canPreview: false }

  // 1. Office documents — rendered via the bundled OfficeCLI binary
  if (SPREADSHEET_EXTENSIONS.has(ext))   return { type: 'spreadsheet', canPreview: true }
  if (RICH_DOCUMENT_EXTENSIONS.has(ext)) return { type: 'richDocument', canPreview: true }
  if (PRESENTATION_EXTENSIONS.has(ext))  return { type: 'presentation', canPreview: true }

  // 2. HTML ahead of code — .html is in CODE_EXTENSIONS too, and rendering the
  //    page is the useful default
  if (HTML_EXTENSIONS.has(ext))     return { type: 'html', canPreview: true }

  // 3. Media — image ahead of code so .svg previews as an image
  if (IMAGE_EXTENSIONS.has(ext))    return { type: 'image', canPreview: true }
  if (AUDIO_EXTENSIONS.has(ext))    return { type: 'audio', canPreview: true }
  if (VIDEO_EXTENSIONS.has(ext))    return { type: 'video', canPreview: true }
  if (PDF_EXTENSIONS.has(ext))      return { type: 'pdf', canPreview: true }

  // 4-8. Text-shaped formats, most specific first
  if (EXCALIDRAW_EXTENSIONS.has(ext)) return { type: 'excalidraw', canPreview: true }
  if (MARKDOWN_EXTENSIONS.has(ext)) return { type: 'markdown', canPreview: true }
  if (JSON_EXTENSIONS.has(ext))     return { type: 'json', canPreview: true }
  if (CODE_EXTENSIONS.has(ext))     return { type: 'code', canPreview: true }
  if (TEXT_EXTENSIONS.has(ext))     return { type: 'text', canPreview: true }

  return { type: null, canPreview: false }
}

/**
 * Regex alternation of all known file extensions (e.g. "ts|tsx|js|...").
 * Derived from the classification sets above so link detection stays in sync
 * with preview support automatically.
 */
export const FILE_EXTENSIONS_PATTERN = [
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...EXCALIDRAW_EXTENSIONS,
  ...SPREADSHEET_EXTENSIONS,
  ...RICH_DOCUMENT_EXTENSIONS,
  ...PRESENTATION_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ...EXTERNAL_EXTENSIONS,
].join('|')
