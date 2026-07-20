import { classifyFile, type FilePreviewType } from '@craft-agent/ui/file-classification'

export interface RightSidebarPreviewSelection {
  sessionId: string
  filePath: string
}

export type InlinePreviewLoadKind = 'image' | 'text' | 'unsupported'

const INLINE_TEXT_PREVIEW_TYPES: ReadonlySet<FilePreviewType> = new Set([
  'code',
  'text',
  'markdown',
  'json',
  'excalidraw',
])

export function isInlineFilePreviewType(type: FilePreviewType | null): boolean {
  return type === 'image' || (type !== null && INLINE_TEXT_PREVIEW_TYPES.has(type))
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
  return classification.type === 'image'
    ? { kind: 'image', loading: true }
    : { kind: 'text', loading: true }
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
