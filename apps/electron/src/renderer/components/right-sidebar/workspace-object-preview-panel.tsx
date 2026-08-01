import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { ContentResolver } from '../app-shell/content-resolver'
import { acceptWorkspaceObjectEvent } from '../app-shell/workspace-object-events'
import { onWorkspaceObjectsReload } from '../app-shell/workspace-object-reconnect'
import { ObjectTableView } from '../workspace-objects/ObjectTableView'

interface WorkspaceObjectPreviewData {
  payload: WorkspaceObjectPayload
  relationPayloads: WorkspaceObjectPayload[]
}

export function WorkspaceObjectPreviewPanel({
  workspaceId,
  objectId,
  viewId,
}: {
  workspaceId: string
  objectId: string
  viewId?: string
}) {
  const { t } = useTranslation()
  const resolverRef = React.useRef<ContentResolver<WorkspaceObjectPreviewData> | null>(null)
  if (!resolverRef.current) resolverRef.current = new ContentResolver<WorkspaceObjectPreviewData>(20)
  const [data, setData] = React.useState<WorkspaceObjectPreviewData | null>(null)
  const [refreshError, setRefreshError] = React.useState<Error | null>(null)
  const retryRef = React.useRef<() => void>(() => {})
  const revisionsRef = React.useRef(new Map<string, { revision: number; projectionStatus: WorkspaceObjectPayload['projectionStatus'] }>())
  const relationObjectIdsRef = React.useRef(new Set<string>())
  const target = React.useMemo(() => ({ kind: 'object' as const, workspaceId, objectId }), [workspaceId, objectId])

  const fetchData = React.useCallback(async (signal: AbortSignal): Promise<WorkspaceObjectPreviewData> => {
    const result = await window.electronAPI.executeWorkspaceObjectAction(workspaceId, { action: 'get-object', objectId })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!('payload' in result) || !result.payload) throw new Error(`Object not found: ${objectId}`)
    const relationObjectIds = new Set(result.payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []))
    const relationResults = await Promise.all([...relationObjectIds].map(relationObjectId => (
      window.electronAPI.executeWorkspaceObjectAction(workspaceId, { action: 'get-object', objectId: relationObjectId })
    )))
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return {
      payload: result.payload,
      relationPayloads: relationResults.flatMap(candidate => 'payload' in candidate && candidate.payload ? [candidate.payload] : []),
    }
  }, [workspaceId, objectId])

  const mutate = React.useCallback((action: WorkspaceObjectAction): Promise<WorkspaceObjectServiceResult> => (
    window.electronAPI.executeWorkspaceObjectAction(workspaceId, action)
  ), [workspaceId])

  React.useEffect(() => {
    const resolver = resolverRef.current!
    let active = true
    const applyData = (value: WorkspaceObjectPreviewData) => {
      revisionsRef.current.set(value.payload.id, { revision: value.payload.revision, projectionStatus: value.payload.projectionStatus })
      for (const relation of value.relationPayloads) {
        revisionsRef.current.set(relation.id, { revision: relation.revision, projectionStatus: relation.projectionStatus })
      }
      relationObjectIdsRef.current = new Set(value.payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []))
      setData(value)
      setRefreshError(null)
    }
    const reportError = (error: unknown) => {
      if (!active) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      const normalized = error instanceof Error ? error : new Error(String(error))
      setRefreshError(normalized)
      console.error('[WorkspaceObjectPreview]', normalized)
    }
    const refreshPayload = () => {
      const refresh = resolver.refresh(target, fetchData)
      if (refresh.current) setData(refresh.current)
      void refresh.promise.then(value => {
        if (active && value) applyData(value)
      }).catch(reportError)
    }
    retryRef.current = refreshPayload
    void resolver.load(target, fetchData).then(value => {
      if (!active) return
      applyData(value)
    }).catch(reportError)
    const unsubscribe = window.electronAPI.onWorkspaceObjectEvent(event => {
      const relevant = event.objectId === objectId || relationObjectIdsRef.current.has(event.objectId)
      if (!relevant || !acceptWorkspaceObjectEvent(revisionsRef.current, workspaceId, event)) return
      refreshPayload()
    })
    const unsubscribeReload = onWorkspaceObjectsReload(reloadedWorkspaceId => {
      if (reloadedWorkspaceId === workspaceId) refreshPayload()
    })
    return () => { active = false; retryRef.current = () => {}; resolver.invalidate(target); unsubscribe(); unsubscribeReload() }
  }, [target, fetchData, workspaceId, objectId])

  React.useEffect(() => () => resolverRef.current?.dispose(), [])

  if (!data && !refreshError) return <div className="p-4 text-xs text-muted-foreground">{t('chat.workspaceObjectPreviewLoading')}</div>
  return (
    <div className="h-full min-h-0 overflow-auto p-3">
      {data ? <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{data.payload.name}</h3>
        <span className="text-[11px] text-muted-foreground">r{data.payload.revision}</span>
      </div> : null}
      {refreshError ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <div>{t('chat.workspaceObjectRefreshFailed')}: {refreshError.message}</div>
          <button type="button" className="mt-2 underline underline-offset-2" onClick={() => retryRef.current()}>
            {t('chat.workspaceObjectRetry')}
          </button>
        </div>
      ) : null}
      {data?.payload.projectionStatus === 'projection-error' ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{t('chat.workspaceObjectProjectionRepair')}</div>
      ) : null}
      {data ? <ObjectTableView key={viewId ?? 'default'} payload={data.payload} relationPayloads={data.relationPayloads} mutate={mutate} initialViewId={viewId} /> : null}
    </div>
  )
}
