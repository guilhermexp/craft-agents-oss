import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import {
  buildWorkspaceObjectRelationLabels,
  evaluateWorkspaceObjectQuery,
  getWorkspaceObjectEntryLabel,
} from '@craft-agent/shared/workspace-objects/query'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type {
  WorkspaceObjectEntry,
  WorkspaceObjectField,
  WorkspaceObjectPayload,
  WorkspaceObjectValue,
} from '@craft-agent/shared/workspace-objects/types'
import {
  DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW,
  WorkspaceObjectSavedViewSchema,
  WorkspaceObjectViewConfigSchema,
  type WorkspaceObjectFilterClause,
  type WorkspaceObjectSavedView,
  type WorkspaceObjectViewConfig,
} from '@craft-agent/shared/workspace-objects/view-schema'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { ObjectFieldEditor, type ObjectRelationOption } from './ObjectFieldEditor'
import {
  OBJECT_VIEW_ADAPTERS,
  ObjectViewHost,
  withObjectViewAdapter,
  type ObjectViewAdapterId,
} from './ObjectViewHost'
import {
  collectReferencedRelationEntryIds,
  loadReferencedRelationOptions,
  RelationOptionLoadError,
  type RelationOptionErrorCode,
} from './relation-options'

type MutateWorkspaceObject = (action: WorkspaceObjectAction) => Promise<WorkspaceObjectServiceResult>
export interface RelationOptionPage {
  options: ObjectRelationOption[]
  nextCursor: string | null
  revision: number
}
export interface RelationOptionViewState {
  pages: Record<string, RelationOptionPage>
  error: RelationOptionViewError | null
}
export interface RelationOptionViewError {
  relationObjectId: string
  code: RelationOptionErrorCode
  detail?: string
}
export type RelationOptionLoadResult =
  | { status: 'success'; page: RelationOptionPage }
  | { status: 'error'; code: RelationOptionErrorCode; detail?: string }
const EMPTY_RELATION_OPTION_PAGES: Record<string, RelationOptionPage> = {}
const OBJECT_VIEW_ADAPTER_LABEL_KEYS: Record<ObjectViewAdapterId, string> = {
  table: 'chat.workspaceObjectAdapterTable',
  kanban: 'chat.workspaceObjectAdapterKanban',
  calendar: 'chat.workspaceObjectAdapterCalendar',
  timeline: 'chat.workspaceObjectAdapterTimeline',
  gallery: 'chat.workspaceObjectAdapterGallery',
  list: 'chat.workspaceObjectAdapterList',
}

export function canonicalSavedViewFingerprint(payload: WorkspaceObjectPayload, viewId?: string): string | null {
  const view = payload.savedViews.find(candidate => candidate.id === viewId)
  return view ? JSON.stringify(view) : null
}

export function appendRelationOptionPage(current: RelationOptionPage, incoming: RelationOptionPage): RelationOptionPage | null {
  if (current.revision !== incoming.revision) return null
  return {
    options: [...new Map([...current.options, ...incoming.options].map(option => [option.id, option])).values()],
    nextCursor: incoming.nextCursor,
    revision: current.revision,
  }
}

export async function requestRelationOptionPage(
  action: Extract<WorkspaceObjectAction, { action: 'list-relation-options' }>,
  mutate: MutateWorkspaceObject,
  referencedIds?: string[],
): Promise<RelationOptionLoadResult> {
  try {
    if (referencedIds) {
      return {
        status: 'success',
        page: await loadReferencedRelationOptions(action.objectId, referencedIds, mutate),
      }
    }
    const result = await mutate(action)
    if (!('relationOptions' in result)) return { status: 'error', code: 'invalid-response' }
    return {
      status: 'success',
      page: { options: result.relationOptions, nextCursor: result.nextCursor, revision: result.revision },
    }
  } catch (error) {
    if (error instanceof RelationOptionLoadError) return { status: 'error', code: error.code }
    return { status: 'error', code: 'transport', detail: error instanceof Error ? error.message : String(error) }
  }
}

export function applyRelationOptionLoadResult(
  state: RelationOptionViewState,
  relationObjectId: string,
  result: RelationOptionLoadResult,
  mode: 'append' | 'replace' = 'append',
): RelationOptionViewState {
  if (result.status === 'error') {
    return {
      ...state,
      error: { relationObjectId, code: result.code, ...(result.detail === undefined ? {} : { detail: result.detail }) },
    }
  }
  if (mode === 'replace') {
    const current = state.pages[relationObjectId]
    if (current && result.page.revision < current.revision) {
      return {
        ...state,
        error: { relationObjectId, code: 'stale-snapshot' },
      }
    }
    return { pages: { ...state.pages, [relationObjectId]: result.page }, error: null }
  }
  const current = state.pages[relationObjectId]
  if (!current) {
    return { pages: { ...state.pages, [relationObjectId]: result.page }, error: null }
  }
  const page = appendRelationOptionPage(current, result.page)
  return page
    ? { pages: { ...state.pages, [relationObjectId]: page }, error: null }
    : {
        ...state,
        error: { relationObjectId, code: 'changed-while-loading' },
      }
}

const RELATION_OPTION_ERROR_KEYS: Record<RelationOptionErrorCode, string> = {
  'invalid-response': 'chat.workspaceObjectRelationInvalidResponse',
  'stale-snapshot': 'chat.workspaceObjectRelationStaleSnapshot',
  'changed-while-loading': 'chat.workspaceObjectRelationChangedWhileLoading',
  transport: 'chat.workspaceObjectRelationTransportError',
}

export function ObjectRelationOptionErrorAlert({
  error,
  onRetry,
}: {
  error: RelationOptionViewError
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
      <div>
        <div>{t(RELATION_OPTION_ERROR_KEYS[error.code])}</div>
        {error.detail ? (
          <div data-object-relation-error-detail="true" className="mt-1 break-words text-[11px] opacity-80">
            {error.detail}
          </div>
        ) : null}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {t('chat.workspaceObjectPreviewRetry')}
      </Button>
    </div>
  )
}

export function reconcileRelationOptionPages(
  current: Record<string, RelationOptionPage>,
  incoming: Record<string, RelationOptionPage>,
): Record<string, RelationOptionPage> {
  return Object.fromEntries(Object.entries(incoming).map(([objectId, page]) => {
    const accumulated = current[objectId]
    if (!accumulated || accumulated.revision !== page.revision) return [objectId, page]
    return [objectId, {
      options: [...new Map([...accumulated.options, ...page.options].map(option => [option.id, option])).values()],
      nextCursor: accumulated.nextCursor,
      revision: page.revision,
    }]
  }))
}

export function createSavedTableView(
  id: string,
  name: string,
  config: WorkspaceObjectViewConfig,
): WorkspaceObjectSavedView {
  return WorkspaceObjectSavedViewSchema.parse({ id, name, config })
}

export function restoreSavedTableView(view: WorkspaceObjectSavedView): WorkspaceObjectViewConfig {
  return WorkspaceObjectViewConfigSchema.parse(view.config)
}

export function resolveSavedTableViewState(payload: WorkspaceObjectPayload, viewId?: string): {
  activeViewId: string
  viewName: string
  config: WorkspaceObjectViewConfig
} {
  const view = payload.savedViews.find(candidate => candidate.id === viewId)
  return view
    ? { activeViewId: view.id, viewName: view.name, config: restoreSavedTableView(view) }
    : { activeViewId: '', viewName: '', config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW }
}

export function shouldPersistSavedViewTarget(
  payload: WorkspaceObjectPayload,
  activeViewId: string,
  targetViewId?: string,
): boolean {
  return activeViewId !== targetViewId && payload.savedViews.some(view => view.id === activeViewId)
}

export function resolveTablePresentation(config: WorkspaceObjectViewConfig): {
  density: 'compact' | 'comfortable'
  pageSize: number
} {
  const configuredPageSize = config.presentation.settings.pageSize
  const pageSize = typeof configuredPageSize === 'number'
    && Number.isInteger(configuredPageSize)
    && configuredPageSize >= 1
    && configuredPageSize <= 200
    ? configuredPageSize
    : 50
  return {
    density: config.presentation.settings.density === 'compact' ? 'compact' : 'comfortable',
    pageSize,
  }
}

function buildRelationContext(payloads: WorkspaceObjectPayload[]): {
  labels: Map<string, string>
  optionsByObjectId: Map<string, ObjectRelationOption[]>
} {
  const labels = buildWorkspaceObjectRelationLabels(payloads)
  const optionsByObjectId = new Map<string, ObjectRelationOption[]>()
  for (const payload of payloads) {
    const options = payload.entries.map(entry => {
      const label = getWorkspaceObjectEntryLabel(payload, entry)
      return { id: entry.id, label }
    })
    optionsByObjectId.set(payload.id, options)
  }
  return { labels, optionsByObjectId }
}

function countFilterRules(filter: WorkspaceObjectFilterClause | null): number {
  if (!filter) return 0
  return filter.type === 'rule' ? 1 : filter.clauses.reduce((total, clause) => total + countFilterRules(clause), 0)
}

function appendAndFilter(
  filter: WorkspaceObjectFilterClause | null,
  clause: WorkspaceObjectFilterClause,
): WorkspaceObjectFilterClause {
  if (!filter) return clause
  if (filter.type === 'group' && filter.conjunction === 'and') return { ...filter, clauses: [...filter.clauses, clause] }
  return { type: 'group', conjunction: 'and', clauses: [filter, clause] }
}

function nextSort(config: WorkspaceObjectViewConfig, fieldId: string): WorkspaceObjectViewConfig['sort'] {
  const current = config.sort.find(sort => sort.fieldId === fieldId)
  if (!current) return [...config.sort, { fieldId, direction: 'asc' }]
  if (current.direction === 'asc') return config.sort.map(sort => sort.fieldId === fieldId ? { ...sort, direction: 'desc' } : sort)
  return config.sort.filter(sort => sort.fieldId !== fieldId)
}

function parseFilterValue(
  field: WorkspaceObjectField,
  draft: string,
  formatError: (key: 'chat.workspaceObjectFieldFiniteNumber' | 'chat.workspaceObjectFieldBoolean', values: { field: string }) => string,
): WorkspaceObjectValue {
  if (field.type === 'number') {
    const value = Number(draft)
    if (!Number.isFinite(value)) throw new Error(formatError('chat.workspaceObjectFieldFiniteNumber', { field: field.name }))
    return value
  }
  if (field.type === 'boolean') {
    if (draft !== 'true' && draft !== 'false') throw new Error(formatError('chat.workspaceObjectFieldBoolean', { field: field.name }))
    return draft === 'true'
  }
  return draft
}

export interface ObjectTableViewProps {
  payload: WorkspaceObjectPayload
  relationPayloads: WorkspaceObjectPayload[]
  mutate: MutateWorkspaceObject
  initialViewId?: string
  onViewIdChange?: (viewId: string | undefined) => void
  relationOptionPages?: Record<string, RelationOptionPage>
}

export function ObjectTableView({ payload, relationPayloads, mutate, initialViewId, onViewIdChange, relationOptionPages = EMPTY_RELATION_OPTION_PAGES }: ObjectTableViewProps) {
  const { t } = useTranslation()
  const initialState = resolveSavedTableViewState(payload, initialViewId)
  const [config, setConfig] = React.useState<WorkspaceObjectViewConfig>(initialState.config)
  const [activeViewId, setActiveViewId] = React.useState(initialState.activeViewId)
  const [viewName, setViewName] = React.useState(initialState.viewName)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [savingView, setSavingView] = React.useState(false)
  const [filterFieldId, setFilterFieldId] = React.useState(payload.fields[0]?.id ?? '')
  const [filterDraft, setFilterDraft] = React.useState('')
  const [filterError, setFilterError] = React.useState<string | null>(null)
  const [relationState, setRelationState] = React.useState<RelationOptionViewState>({ pages: relationOptionPages, error: null })
  const relationPages = relationState.pages
  const [loadingRelationObjectId, setLoadingRelationObjectId] = React.useState<string | null>(null)

  const relationContext = React.useMemo(() => {
    const context = buildRelationContext(relationPayloads)
    for (const [objectId, page] of Object.entries(relationPages)) {
      context.optionsByObjectId.set(objectId, page.options)
      for (const option of page.options) context.labels.set(option.id, option.label)
    }
    return context
  }, [relationPayloads, relationPages])
  const query = React.useMemo(
    () => evaluateWorkspaceObjectQuery(payload, config, { relationLabels: relationContext.labels }),
    [payload, config, relationContext.labels],
  )

  const canonicalViewFingerprint = canonicalSavedViewFingerprint(payload, initialViewId)
  React.useEffect(() => {
    if (!canonicalViewFingerprint) return
    const canonical = WorkspaceObjectSavedViewSchema.parse(JSON.parse(canonicalViewFingerprint))
    setActiveViewId(canonical.id)
    setViewName(canonical.name)
    setConfig(restoreSavedTableView(canonical))
  }, [canonicalViewFingerprint])

  React.useEffect(() => {
    if (shouldPersistSavedViewTarget(payload, activeViewId, initialViewId)) onViewIdChange?.(activeViewId)
  }, [activeViewId, initialViewId, onViewIdChange, payload])

  React.useEffect(() => {
    setRelationState(current => ({ pages: reconcileRelationOptionPages(current.pages, relationOptionPages), error: null }))
  }, [relationOptionPages])

  const loadMoreRelationOptions = React.useCallback(async (relationObjectId: string) => {
    const current = relationPages[relationObjectId]
    if (!current?.nextCursor || loadingRelationObjectId) return
    setLoadingRelationObjectId(relationObjectId)
    try {
      const result = await requestRelationOptionPage({
        action: 'list-relation-options', objectId: relationObjectId, after: current.nextCursor, limit: 200,
      }, mutate)
      setRelationState(state => applyRelationOptionLoadResult(state, relationObjectId, result))
    } finally {
      setLoadingRelationObjectId(null)
    }
  }, [loadingRelationObjectId, mutate, relationPages])

  const reloadRelationOptions = React.useCallback(async (relationObjectId: string) => {
    if (loadingRelationObjectId) return
    setLoadingRelationObjectId(relationObjectId)
    try {
      const result = await requestRelationOptionPage({
        action: 'list-relation-options', objectId: relationObjectId, limit: 200,
      }, mutate, collectReferencedRelationEntryIds(payload, relationObjectId))
      setRelationState(state => applyRelationOptionLoadResult(state, relationObjectId, result, 'replace'))
    } finally {
      setLoadingRelationObjectId(null)
    }
  }, [loadingRelationObjectId, mutate, payload])

  const selectView = (viewId: string) => {
    if (!viewId) {
      setActiveViewId('')
      setConfig(DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW)
      setViewName('')
      onViewIdChange?.(undefined)
      return
    }
    const view = payload.savedViews.find(candidate => candidate.id === viewId)
    if (!view) return
    setActiveViewId(viewId)
    setConfig(restoreSavedTableView(view))
    setViewName(view.name)
  }

  const addFilter = () => {
    const field = payload.fields.find(candidate => candidate.id === filterFieldId)
    if (!field) {
      setFilterError(t('chat.workspaceObjectFilterFieldRequired'))
      return
    }
    try {
      const value = parseFilterValue(field, filterDraft, (key, values) => t(key, values))
      const operator = field.type === 'text' || field.type === 'file' || field.type === 'relation' ? 'contains' : 'equals'
      setConfig(current => ({
        ...current,
        filter: appendAndFilter(current.filter, { type: 'rule', fieldId: field.id, operator, value }),
      }))
      setFilterDraft('')
      setFilterError(null)
    } catch (error) {
      setFilterError(error instanceof Error ? error.message : String(error))
    }
  }

  const configureAdapterSetting = React.useCallback((settingKey: string, fieldId: string) => {
    setConfig(current => ({
      ...current,
      presentation: {
        ...current.presentation,
        settings: { ...current.presentation.settings, [settingKey]: fieldId },
      },
    }))
  }, [])

  const saveView = async () => {
    const normalizedName = viewName.trim()
    if (!normalizedName) {
      setSaveError(t('chat.workspaceObjectViewNameRequired'))
      return
    }
    setSavingView(true)
    setSaveError(null)
    const id = activeViewId || `view_${crypto.randomUUID()}`
    const view = createSavedTableView(id, normalizedName, config)
    try {
      const result = await mutate({ action: 'upsert-view', objectId: payload.id, view })
      if (!('objectId' in result) || !('revision' in result) || result.objectId !== payload.id) throw new Error(t('chat.workspaceObjectCommitMissing'))
      setActiveViewId(id)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingView(false)
    }
  }

  const columns = React.useMemo<ColumnDef<WorkspaceObjectEntry, unknown>[]>(() => query.fields.map(field => {
    const sort = config.sort.find(candidate => candidate.fieldId === field.id)
    return {
      id: field.id,
      header: () => (
        <button
          type="button"
          className="flex w-full items-center gap-1 text-left text-xs font-medium"
          onClick={() => setConfig(current => ({ ...current, sort: nextSort(current, field.id) }))}
        >
          <span>{field.name}</span>
          {sort ? <span className="text-[10px] text-muted-foreground">{sort.direction === 'asc' ? '↑' : '↓'}{config.sort.indexOf(sort) + 1}</span> : null}
        </button>
      ),
      accessorFn: entry => query.displayValues.get(entry.id)?.[field.id],
      cell: ({ row }) => (
        <ObjectFieldEditor
          objectId={payload.id}
          entryId={row.original.id}
          field={field}
          value={row.original.values[field.id]}
          currentValues={row.original.values}
          payloadRevision={payload.revision}
          relationOptions={field.relationObjectId ? relationContext.optionsByObjectId.get(field.relationObjectId) ?? [] : []}
          relationLabels={relationContext.labels}
          hasMoreRelationOptions={field.relationObjectId ? Boolean(relationPages[field.relationObjectId]?.nextCursor) : false}
          loadingRelationOptions={field.relationObjectId === loadingRelationObjectId}
          onLoadMoreRelationOptions={field.relationObjectId ? () => loadMoreRelationOptions(field.relationObjectId!) : undefined}
          mutate={mutate}
        />
      ),
    }
  }), [config.sort, loadMoreRelationOptions, loadingRelationObjectId, mutate, payload.id, payload.revision, query.displayValues, query.fields, relationContext.labels, relationContext.optionsByObjectId, relationPages])

  const filterField = payload.fields.find(field => field.id === filterFieldId)
  const tablePresentation = resolveTablePresentation(config)
  return (
    <div className="space-y-3">
      {relationState.error ? (
        <ObjectRelationOptionErrorAlert
          error={relationState.error}
          onRetry={() => void reloadRelationOptions(relationState.error!.relationObjectId)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 min-w-36 rounded border border-foreground/15 bg-background px-2 text-xs"
          value={activeViewId}
          aria-label={t('chat.workspaceObjectSavedViews')}
          onChange={event => selectView(event.target.value)}
        >
          <option value="">{t('chat.workspaceObjectDefaultView')}</option>
          {payload.savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
        <select
          className="h-8 min-w-32 rounded border border-foreground/15 bg-background px-2 text-xs"
          value={config.presentation.adapter}
          aria-label={t('chat.workspaceObjectViewAdapter')}
          onChange={event => setConfig(current => withObjectViewAdapter(current, event.target.value as ObjectViewAdapterId))}
        >
          {OBJECT_VIEW_ADAPTERS.map(adapter => (
            <option key={adapter.id} value={adapter.id}>{t(OBJECT_VIEW_ADAPTER_LABEL_KEYS[adapter.id])}</option>
          ))}
        </select>
        <Input
          className="h-8 min-w-40 flex-1 text-xs"
          value={config.search}
          placeholder={t('chat.workspaceObjectSearch')}
          aria-label={t('chat.workspaceObjectSearch')}
          onChange={event => setConfig(current => ({ ...current, search: event.target.value }))}
        />
        <details className="relative">
          <summary className="flex h-8 cursor-pointer list-none items-center rounded border border-foreground/15 px-2 text-xs">
            {t('chat.workspaceObjectColumns')}
          </summary>
          <div className="absolute right-0 z-20 mt-1 min-w-48 space-y-1 rounded border bg-popover p-2 shadow-md">
            {payload.fields.map(field => (
              <label key={field.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={config.columnVisibility[field.id] !== false}
                  onChange={event => setConfig(current => ({
                    ...current,
                    columnVisibility: { ...current.columnVisibility, [field.id]: event.target.checked },
                  }))}
                />
                <span>{field.name}</span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-start gap-2 rounded border border-foreground/10 p-2">
        <select
          className="h-8 rounded border border-foreground/15 bg-background px-2 text-xs"
          value={filterFieldId}
          aria-label={t('chat.workspaceObjectFilterField')}
          onChange={event => setFilterFieldId(event.target.value)}
        >
          {payload.fields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
        </select>
        {filterField?.type === 'select' || filterField?.type === 'status' || filterField?.type === 'boolean' ? (
          <select
            className="h-8 rounded border border-foreground/15 bg-background px-2 text-xs"
            value={filterDraft}
            aria-label={t('chat.workspaceObjectFilterValue')}
            onChange={event => setFilterDraft(event.target.value)}
          >
            <option value="">—</option>
            {filterField.type === 'boolean'
              ? <><option value="true">true</option><option value="false">false</option></>
              : filterField.options?.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : (
          <Input
            className="h-8 min-w-32 flex-1 text-xs"
            value={filterDraft}
            placeholder={t('chat.workspaceObjectFilterValue')}
            aria-label={t('chat.workspaceObjectFilterValue')}
            onChange={event => setFilterDraft(event.target.value)}
          />
        )}
        <Button type="button" size="sm" className="h-8 text-xs" onClick={addFilter}>{t('chat.workspaceObjectAddFilter')}</Button>
        {config.filter ? (
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setConfig(current => ({ ...current, filter: null }))}>
            {t('chat.workspaceObjectClearFilters', { count: countFilterRules(config.filter) })}
          </Button>
        ) : null}
        {filterError ? <div className="w-full text-[11px] text-destructive" role="alert">{filterError}</div> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 min-w-40 flex-1 text-xs"
          value={viewName}
          placeholder={t('chat.workspaceObjectViewName')}
          aria-label={t('chat.workspaceObjectViewName')}
          onChange={event => setViewName(event.target.value)}
        />
        <Button type="button" size="sm" className="h-8 text-xs" disabled={savingView} onClick={() => void saveView()}>
          {savingView ? t('chat.workspaceObjectSavingView') : t('chat.workspaceObjectSaveView')}
        </Button>
        {saveError ? <div className="w-full text-[11px] text-destructive" role="alert">{saveError}</div> : null}
      </div>

      <ObjectViewHost
        payload={payload}
        config={config}
        query={query}
        mutate={mutate}
        onConfigureSetting={configureAdapterSetting}
        onChangeAdapter={adapter => setConfig(current => withObjectViewAdapter(current, adapter))}
        tableContent={(
          <DataTable
            key={`${tablePresentation.density}:${tablePresentation.pageSize}`}
            columns={columns}
            data={query.entries}
            getRowId={entry => entry.id}
            pagination
            pageSize={tablePresentation.pageSize}
            className={tablePresentation.density === 'compact' ? '[&_td]:!p-1 [&_th]:!p-1' : undefined}
            emptyContent={t('chat.workspaceObjectNoRows')}
          />
        )}
      />
    </div>
  )
}
