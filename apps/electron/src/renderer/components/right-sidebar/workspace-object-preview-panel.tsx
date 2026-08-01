import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectEntry, WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { DataTable } from '@/components/ui/data-table'
import { ContentResolver } from '../app-shell/content-resolver'
import { acceptWorkspaceObjectEvent } from '../app-shell/workspace-object-events'
import { onWorkspaceObjectsReload } from '../app-shell/workspace-object-reconnect'

export function WorkspaceObjectPreviewPanel({ workspaceId, objectId }: { workspaceId: string; objectId: string }) {
  const { t } = useTranslation()
  const resolverRef = React.useRef<ContentResolver<WorkspaceObjectPayload> | null>(null)
  if (!resolverRef.current) resolverRef.current = new ContentResolver<WorkspaceObjectPayload>(20)
  const [payload, setPayload] = React.useState<WorkspaceObjectPayload | null>(null)
  const [refreshError, setRefreshError] = React.useState<Error | null>(null)
  const retryRef = React.useRef<() => void>(() => {})
  const revisionsRef = React.useRef(new Map<string, { revision: number; projectionStatus: WorkspaceObjectPayload['projectionStatus'] }>())
  const target = React.useMemo(() => ({ kind: 'object' as const, workspaceId, objectId }), [workspaceId, objectId])

  const fetchPayload = React.useCallback(async (signal: AbortSignal): Promise<WorkspaceObjectPayload> => {
    const result = await window.electronAPI.executeWorkspaceObjectAction(workspaceId, { action: 'get-object', objectId })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!('payload' in result) || !result.payload) throw new Error(`Object not found: ${objectId}`)
    return result.payload
  }, [workspaceId, objectId])

  React.useEffect(() => {
    const resolver = resolverRef.current!
    let active = true
    const applyPayload = (value: WorkspaceObjectPayload) => {
      revisionsRef.current.set(value.id, { revision: value.revision, projectionStatus: value.projectionStatus })
      setPayload(value)
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
      const refresh = resolver.refresh(target, fetchPayload)
      if (refresh.current) setPayload(refresh.current)
      void refresh.promise.then(value => {
        if (active && value) applyPayload(value)
      }).catch(reportError)
    }
    retryRef.current = refreshPayload
    void resolver.load(target, fetchPayload).then(value => {
      if (!active) return
      applyPayload(value)
    }).catch(reportError)
    const unsubscribe = window.electronAPI.onWorkspaceObjectEvent(event => {
      if (event.objectId !== objectId || !acceptWorkspaceObjectEvent(revisionsRef.current, workspaceId, event)) return
      refreshPayload()
    })
    const unsubscribeReload = onWorkspaceObjectsReload(reloadedWorkspaceId => {
      if (reloadedWorkspaceId === workspaceId) refreshPayload()
    })
    return () => { active = false; retryRef.current = () => {}; resolver.invalidate(target); unsubscribe(); unsubscribeReload() }
  }, [target, fetchPayload, workspaceId, objectId])

  React.useEffect(() => () => resolverRef.current?.dispose(), [])

  const columns = React.useMemo<ColumnDef<WorkspaceObjectEntry, unknown>[]>(() => (payload?.fields ?? []).map(field => ({
    id: field.id,
    header: field.name,
    accessorFn: row => row.values[field.id],
    cell: info => {
      const value = info.getValue()
      return value === null || value === undefined ? '' : String(value)
    },
  })), [payload?.fields])

  if (!payload && !refreshError) return <div className="p-4 text-xs text-muted-foreground">{t('chat.workspaceObjectPreviewLoading')}</div>
  return (
    <div className="h-full min-h-0 overflow-auto p-3">
      {payload ? <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{payload.name}</h3>
        <span className="text-[11px] text-muted-foreground">r{payload.revision}</span>
      </div> : null}
      {refreshError ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <div>{t('chat.workspaceObjectRefreshFailed')}: {refreshError.message}</div>
          <button type="button" className="mt-2 underline underline-offset-2" onClick={() => retryRef.current()}>
            {t('chat.workspaceObjectRetry')}
          </button>
        </div>
      ) : null}
      {payload?.projectionStatus === 'projection-error' ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{t('chat.workspaceObjectProjectionRepair')}</div>
      ) : null}
      {payload ? <DataTable columns={columns} data={payload.entries} pagination pageSize={50} /> : null}
    </div>
  )
}
