import * as React from 'react'
import { Boxes, Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { acceptWorkspaceObjectEvent } from '../app-shell/workspace-object-events'

export interface WorkspaceObjectsSectionProps {
  onPreviewObject: (objectId: string) => void
}

export function WorkspaceObjectsSection({ onPreviewObject }: WorkspaceObjectsSectionProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [objects, setObjects] = React.useState<WorkspaceObjectPayload[]>([])
  const [loading, setLoading] = React.useState(false)
  const revisionsRef = React.useRef(new Map<string, { revision: number; projectionStatus: WorkspaceObjectPayload['projectionStatus'] }>())

  const load = React.useCallback(async () => {
    if (!activeWorkspaceId) { setObjects([]); return }
    setLoading(true)
    try {
      const result = await window.electronAPI.listWorkspaceObjects(activeWorkspaceId)
      setObjects(result.objects)
      for (const object of result.objects) revisionsRef.current.set(object.id, { revision: object.revision, projectionStatus: object.projectionStatus })
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId])

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    revisionsRef.current.clear()
    void load()
    const unsubscribeEvent = window.electronAPI.onWorkspaceObjectEvent(event => {
      if (acceptWorkspaceObjectEvent(revisionsRef.current, activeWorkspaceId, event)) void load()
    })
    return () => {
      unsubscribeEvent()
    }
  }, [activeWorkspaceId, load])

  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-2">
      {objects.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          {loading ? t('chat.workspaceObjectsLoading') : t('chat.workspaceObjectsEmpty')}
        </div>
      ) : (
        <nav className="grid gap-0.5">
          {objects.map(object => (
            <button
              key={object.id}
              type="button"
              onClick={() => onPreviewObject(object.id)}
              onDoubleClick={() => onPreviewObject(object.id)}
              className="flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] outline-none transition-colors hover:bg-sidebar-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Boxes className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{object.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">r{object.revision}</span>
              {object.projectionStatus === 'projection-error' ? <Database className="size-3 text-destructive" /> : null}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
