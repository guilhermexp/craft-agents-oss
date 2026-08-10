import { classifyFile, type FilePreviewType } from '@craft-agent/ui/file-classification'

export interface RightSidebarPreviewSelection {
  sessionId: string
  filePath: string
}

export type InlinePreviewLoadKind =
  | 'image'
  | 'text'
  | 'pdf'
  | 'video'
  | 'html'
  | 'office'
  | 'unsupported'

const INLINE_TEXT_PREVIEW_TYPES: ReadonlySet<FilePreviewType> = new Set([
  'code',
  'text',
  'markdown',
  'json',
  'excalidraw',
])

/** Office documents are rendered to HTML by the bundled OfficeCLI binary. */
const INLINE_OFFICE_PREVIEW_TYPES: ReadonlySet<FilePreviewType> = new Set([
  'spreadsheet',
  'richDocument',
  'presentation',
])

export function isInlineFilePreviewType(type: FilePreviewType | null): type is FilePreviewType {
  if (type === null) return false
  return (
    type === 'image' ||
    type === 'pdf' ||
    type === 'video' ||
    type === 'html' ||
    INLINE_OFFICE_PREVIEW_TYPES.has(type) ||
    INLINE_TEXT_PREVIEW_TYPES.has(type)
  )
}

export function canPreviewFileInline(filePath: string): boolean {
  const classification = classifyFile(filePath)
  return classification.canPreview && isInlineFilePreviewType(classification.type)
}

export function getInlinePreviewLoadState(filePath: string): {
  kind: InlinePreviewLoadKind
  loading: boolean
} {
  const classification = classifyFile(filePath)
  if (!classification.canPreview || !isInlineFilePreviewType(classification.type)) {
    return { kind: 'unsupported', loading: false }
  }
  if (classification.type === 'pdf') return { kind: 'pdf', loading: true }
  if (classification.type === 'image') return { kind: 'image', loading: true }
  // Video streams over media:// — nothing to fetch up front, so it never shows
  // a loading state; the <video> element handles its own buffering.
  if (classification.type === 'video') return { kind: 'video', loading: false }
  if (classification.type === 'html') return { kind: 'html', loading: true }
  if (INLINE_OFFICE_PREVIEW_TYPES.has(classification.type)) {
    return { kind: 'office', loading: true }
  }
  return { kind: 'text', loading: true }
}

export function getActiveRightSidebarPreviewPath({
  selection,
  sessionId,
  isVisible,
}: {
  selection: RightSidebarPreviewSelection | null
  sessionId: string | null
  isVisible: boolean
}): string | null {
  if (!isVisible || !sessionId || selection?.sessionId !== sessionId) return null
  return selection.filePath
}
