import type { ContentTarget } from './content-tabs-state'
import type { ReactNode } from 'react'
import { InlineFilePreviewPanel } from './SessionInfoPopover'
import { WorkspaceObjectPreviewPanel } from '../right-sidebar/workspace-object-preview-panel'

interface ContentPreviewHostProps {
  target: ContentTarget
  onClose: () => void
  onOpenFileDialog: (path: string) => void
}

type ContentRenderer = (props: ContentPreviewHostProps) => ReactNode

const CONTENT_RENDERERS: Record<ContentTarget['kind'], ContentRenderer> = {
  file: ({ target, onClose, onOpenFileDialog }) => target.kind === 'file' ? (
    <InlineFilePreviewPanel filePath={target.path} onBack={onClose} onOpenDialog={onOpenFileDialog} />
  ) : null,
  object: ({ target }) => target.kind === 'object' ? (
    <WorkspaceObjectPreviewPanel workspaceId={target.workspaceId} objectId={target.objectId} viewId={target.viewId} />
  ) : null,
}

export function ContentPreviewHost(props: ContentPreviewHostProps) {
  return CONTENT_RENDERERS[props.target.kind](props)
}
