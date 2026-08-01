import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { ContentResolver } from '../app-shell/content-resolver'
import { acceptWorkspaceObjectEvent } from '../app-shell/workspace-object-events'
import { onWorkspaceObjectsReload } from '../app-shell/workspace-object-reconnect'
import { contentTabId } from '../app-shell/content-tabs-state'
import { ObjectTableView } from '../workspace-objects/ObjectTableView'
import {
  collectReferencedRelationEntryIds,
  loadReferencedRelationOptions,
  normalizeRelationOptionFailure,
  RELATION_OPTION_ERROR_KEYS,
  type RelationOptionFailure,
} from '../workspace-objects/relation-options'

interface WorkspaceObjectPreviewData {
  targetKey: string
  payload: WorkspaceObjectPayload
  relationOptionPages?: Record<string, { options: Array<{ id: string; label: string }>; nextCursor: string | null; revision: number }>
}

type WorkspaceObjectPreviewRevision = {
  revision: number
  projectionStatus?: WorkspaceObjectPayload['projectionStatus']
}

const EMPTY_RELATION_PAYLOADS: WorkspaceObjectPayload[] = []

export function buildWorkspaceObjectPreviewRevisions(
  payload: WorkspaceObjectPayload,
  relationOptionPages: WorkspaceObjectPreviewData['relationOptionPages'] = {},
  previous: ReadonlyMap<string, WorkspaceObjectPreviewRevision> = new Map(),
): Map<string, WorkspaceObjectPreviewRevision> {
  const revisions = new Map<string, WorkspaceObjectPreviewRevision>([
    [payload.id, { revision: payload.revision, projectionStatus: payload.projectionStatus }],
  ])
  for (const [relationObjectId, page] of Object.entries(relationOptionPages)) {
    if (relationObjectId === payload.id) continue
    const observed = previous.get(relationObjectId)
    revisions.set(relationObjectId, observed?.revision === page.revision ? observed : { revision: page.revision })
  }
  return revisions
}

interface WorkspaceObjectPreviewTarget {
  workspaceId: string
  objectId: string
  viewId?: string
}

export function isWorkspaceObjectPreviewDataCurrent(
  data: WorkspaceObjectPreviewData,
  target: WorkspaceObjectPreviewTarget,
): boolean {
  return data.targetKey === contentTabId({ kind: 'object', ...target })
}

export function workspaceObjectPreviewRenderKey(payload: WorkspaceObjectPayload, viewId?: string): string {
  return `${payload.id}:${viewId ?? 'default'}`
}

export function WorkspaceObjectPreviewErrorAlert({
  error,
  onRetry,
}: {
  error: RelationOptionFailure
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
      <div>{t(RELATION_OPTION_ERROR_KEYS[error.code])}</div>
      {error.code === 'transport' && error.detail ? (
        <div data-object-relation-error-detail="true" className="mt-1 break-words text-[11px] opacity-80">{error.detail}</div>
      ) : null}
      <button type="button" className="mt-2 underline underline-offset-2" onClick={onRetry}>
        {t('chat.workspaceObjectRetry')}
      </button>
    </div>
  )
}

export function WorkspaceObjectPreviewPanel({
  workspaceId,
  objectId,
  viewId,
  onViewIdChange,
}: {
  workspaceId: string
  objectId: string
  viewId?: string
  onViewIdChange?: (viewId: string | undefined) => void
}) {
  const { t } = useTranslation()
  const resolverRef = React.useRef<ContentResolver<WorkspaceObjectPreviewData> | null>(null)
  if (!resolverRef.current) resolverRef.current = new ContentResolver<WorkspaceObjectPreviewData>(20)
  const [data, setData] = React.useState<WorkspaceObjectPreviewData | null>(null)
  const [refreshError, setRefreshError] = React.useState<RelationOptionFailure | null>(null)
  const retryRef = React.useRef<() => void>(() => {})
  const revisionsRef = React.useRef(new Map<string, WorkspaceObjectPreviewRevision>())
  const relationObjectIdsRef = React.useRef(new Set<string>())
  const target = React.useMemo(() => ({ kind: 'object' as const, workspaceId, objectId, ...(viewId === undefined ? {} : { viewId }) }), [workspaceId, objectId, viewId])

  const fetchData = React.useCallback(async (signal: AbortSignal): Promise<WorkspaceObjectPreviewData> => {
    const result = await window.electronAPI.executeWorkspaceObjectAction(workspaceId, { action: 'get-object', objectId })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!('payload' in result) || !result.payload) throw new Error(`Object not found: ${objectId}`)
    const relationObjectIds = new Set(result.payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []))
    const relationResults = await Promise.all([...relationObjectIds].map(async relationObjectId => {
      const includeEntryIds = collectReferencedRelationEntryIds(result.payload!, relationObjectId)
      const page = await loadReferencedRelationOptions(relationObjectId, includeEntryIds, action => (
        window.electronAPI.executeWorkspaceObjectAction(workspaceId, action)
      ))
      return { relationObjectId, page }
    }))
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return {
      targetKey: contentTabId(target),
      payload: result.payload,
      relationOptionPages: Object.fromEntries(relationResults.map(({ relationObjectId, page }) => [relationObjectId, page])),
    }
  }, [workspaceId, objectId, target])

  const mutate = React.useCallback((action: WorkspaceObjectAction): Promise<WorkspaceObjectServiceResult> => (
    window.electronAPI.executeWorkspaceObjectAction(workspaceId, action)
  ), [workspaceId])

  React.useEffect(() => {
    const resolver = resolverRef.current!
    let active = true
    setRefreshError(null)
    revisionsRef.current.clear()
    relationObjectIdsRef.current.clear()
    const applyData = (value: WorkspaceObjectPreviewData) => {
      revisionsRef.current = buildWorkspaceObjectPreviewRevisions(value.payload, value.relationOptionPages, revisionsRef.current)
      relationObjectIdsRef.current = new Set(value.payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []))
      setData(value)
      setRefreshError(null)
    }
    const reportError = (error: unknown) => {
      if (!active) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      const normalized = normalizeRelationOptionFailure(error)
      setRefreshError(normalized)
      console.error('[WorkspaceObjectPreview]', error)
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

  const visibleData = data && isWorkspaceObjectPreviewDataCurrent(data, { workspaceId, objectId, viewId }) ? data : null
  if (!visibleData && !refreshError) return <div className="p-4 text-xs text-muted-foreground">{t('chat.workspaceObjectPreviewLoading')}</div>
  return (
    <div className="h-full min-h-0 overflow-auto p-3">
      {visibleData ? <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{visibleData.payload.name}</h3>
        <span className="text-[11px] text-muted-foreground">r{visibleData.payload.revision}</span>
      </div> : null}
      {refreshError ? (
        <WorkspaceObjectPreviewErrorAlert error={refreshError} onRetry={() => retryRef.current()} />
      ) : null}
      {visibleData?.payload.projectionStatus === 'projection-error' ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{t('chat.workspaceObjectProjectionRepair')}</div>
      ) : null}
      {visibleData ? <ObjectTableView key={workspaceObjectPreviewRenderKey(visibleData.payload, viewId)} payload={visibleData.payload} relationPayloads={EMPTY_RELATION_PAYLOADS} relationOptionPages={visibleData.relationOptionPages} mutate={mutate} initialViewId={viewId} onViewIdChange={onViewIdChange} /> : null}
    </div>
  )
}
