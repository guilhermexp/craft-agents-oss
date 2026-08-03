import * as React from 'react'
import { Boxes, Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { acceptWorkspaceObjectEvent } from '../app-shell/workspace-object-events'
import { onWorkspaceObjectsReload } from '../app-shell/workspace-object-reconnect'

export interface WorkspaceObjectsSectionProps {
  onPreviewObject: (objectId: string, mode: 'preview' | 'permanent') => void
}

export interface WorkspaceObjectListLoadCallbacks {
  onStart: () => void
  onSuccess: (objects: WorkspaceObjectPayload[]) => void
  onError: (error: Error) => void
  onFinish: () => void
  onReset: () => void
}

export class WorkspaceObjectListLoader {
  private generation = 0

  constructor(private readonly listObjects: (workspaceId: string) => Promise<WorkspaceObjectPayload[]>) {}

  async load(workspaceId: string | null, callbacks: WorkspaceObjectListLoadCallbacks): Promise<void> {
    const generation = ++this.generation
    if (!workspaceId) {
      callbacks.onReset()
      return
    }
    callbacks.onStart()
    try {
      const objects = await this.listObjects(workspaceId)
      if (generation === this.generation) callbacks.onSuccess(objects)
    } catch (error) {
      if (generation === this.generation) callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (generation === this.generation) callbacks.onFinish()
    }
  }

  invalidate(): void {
    this.generation += 1
  }
}

export function WorkspaceObjectsSection({ onPreviewObject }: WorkspaceObjectsSectionProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [objects, setObjects] = React.useState<WorkspaceObjectPayload[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<Error | null>(null)
  const revisionsRef = React.useRef(new Map<string, { revision: number; projectionStatus: WorkspaceObjectPayload['projectionStatus'] }>())
  const loaderRef = React.useRef<WorkspaceObjectListLoader | null>(null)
  if (!loaderRef.current) {
    loaderRef.current = new WorkspaceObjectListLoader(async workspaceId => {
      const result = await window.electronAPI.listWorkspaceObjects(workspaceId)
      return result.objects
    })
  }

  const load = React.useCallback(() => loaderRef.current!.load(activeWorkspaceId, {
    onStart: () => { setLoading(true); setError(null) },
    onSuccess: nextObjects => {
      setObjects(nextObjects)
      revisionsRef.current.clear()
      for (const object of nextObjects) revisionsRef.current.set(object.id, { revision: object.revision, projectionStatus: object.projectionStatus })
    },
    onError: setError,
    onFinish: () => setLoading(false),
    onReset: () => {
      revisionsRef.current.clear()
      setObjects([])
      setLoading(false)
      setError(null)
    },
  }), [activeWorkspaceId])

  React.useEffect(() => {
    return () => loaderRef.current?.invalidate()
  }, [])

  React.useEffect(() => {
    revisionsRef.current.clear()
    if (activeWorkspaceId) {
      setObjects([])
      setError(null)
    }
    void load()
    if (!activeWorkspaceId) return () => loaderRef.current?.invalidate()
    const unsubscribeEvent = window.electronAPI.onWorkspaceObjectEvent(event => {
      if (acceptWorkspaceObjectEvent(revisionsRef.current, activeWorkspaceId, event)) void load()
    })
    const unsubscribeReload = onWorkspaceObjectsReload(reloadedWorkspaceId => {
      if (reloadedWorkspaceId === activeWorkspaceId) void load()
    })
    return () => {
      loaderRef.current?.invalidate()
      unsubscribeEvent()
      unsubscribeReload()
    }
  }, [activeWorkspaceId, load])

  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-2">
      {error ? (
        <div className="mx-2 mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <div>{t('chat.workspaceObjectRefreshFailed')}: {error.message}</div>
          <button type="button" className="mt-2 underline underline-offset-2" onClick={() => { void load() }}>
            {t('chat.workspaceObjectRetry')}
          </button>
        </div>
      ) : null}
      {objects.length === 0 ? (
        error ? null : <div className="px-2 py-3 text-xs text-muted-foreground">
          {loading ? t('chat.workspaceObjectsLoading') : t('chat.workspaceObjectsEmpty')}
        </div>
      ) : (
        <nav className="grid gap-0.5">
          {objects.map(object => (
            <button
              key={object.id}
              type="button"
              onClick={() => onPreviewObject(object.id, 'preview')}
              onDoubleClick={() => onPreviewObject(object.id, 'permanent')}
              className="flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] outline-none transition-colors hover:bg-sidebar-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Boxes className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{object.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">r{object.revision}</span>
              {object.projectionStatus === 'projection-error' ? (
                <Database
                  className="size-3 text-destructive"
                  role="img"
                  aria-label={t('chat.workspaceObjectProjectionRepair')}
                />
              ) : null}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
