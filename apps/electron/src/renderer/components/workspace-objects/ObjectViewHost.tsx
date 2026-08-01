import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import type { WorkspaceObjectQueryResult } from '@craft-agent/shared/workspace-objects/query'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type {
  WorkspaceObjectEntry,
  WorkspaceObjectField,
  WorkspaceObjectPayload,
  WorkspaceObjectValue,
} from '@craft-agent/shared/workspace-objects/types'
import type { WorkspaceObjectViewConfig } from '@craft-agent/shared/workspace-objects/view-schema'
import { Button } from '@/components/ui/button'
import { SmartPointerSensor } from '@/components/ui/sortable-list'

export type ObjectViewAdapterId = WorkspaceObjectViewConfig['presentation']['adapter']
type MutateWorkspaceObject = (action: WorkspaceObjectAction) => Promise<WorkspaceObjectServiceResult>

export interface ObjectViewAdapterDefinition {
  id: ObjectViewAdapterId
  settingKey: string | null
  compatibleFieldTypes: readonly WorkspaceObjectField['type'][]
}

export const OBJECT_VIEW_ADAPTERS: readonly ObjectViewAdapterDefinition[] = [
  { id: 'table', settingKey: null, compatibleFieldTypes: [] },
  { id: 'kanban', settingKey: 'groupFieldId', compatibleFieldTypes: ['select', 'status'] },
  { id: 'calendar', settingKey: 'dateFieldId', compatibleFieldTypes: ['date', 'datetime'] },
  { id: 'timeline', settingKey: 'dateFieldId', compatibleFieldTypes: ['date', 'datetime'] },
  { id: 'gallery', settingKey: 'mediaFieldId', compatibleFieldTypes: ['file'] },
  { id: 'list', settingKey: 'primaryFieldId', compatibleFieldTypes: ['text', 'number', 'boolean', 'date', 'datetime', 'select', 'status', 'relation', 'file'] },
]

export function getObjectViewAdapter(adapterId: string): ObjectViewAdapterDefinition | null {
  return OBJECT_VIEW_ADAPTERS.find(adapter => adapter.id === adapterId) ?? null
}

export function withObjectViewAdapter(
  config: WorkspaceObjectViewConfig,
  adapter: ObjectViewAdapterId,
): WorkspaceObjectViewConfig {
  return {
    ...config,
    presentation: { ...config.presentation, adapter },
  }
}

export type ObjectViewConfiguration =
  | { status: 'ready'; adapterId: ObjectViewAdapterId; field: WorkspaceObjectField | null }
  | {
      status: 'empty'
      adapterId: ObjectViewAdapterId
      settingKey: string
      compatibleFields: WorkspaceObjectField[]
    }

export function resolveObjectViewConfiguration(
  payload: WorkspaceObjectPayload,
  config: WorkspaceObjectViewConfig,
): ObjectViewConfiguration {
  const adapter = getObjectViewAdapter(config.presentation.adapter)
  if (!adapter) {
    return { status: 'empty', adapterId: config.presentation.adapter, settingKey: 'adapter', compatibleFields: [] }
  }
  if (!adapter.settingKey) return { status: 'ready', adapterId: adapter.id, field: null }
  const compatibleFields = payload.fields.filter(field => (
    adapter.compatibleFieldTypes.includes(field.type)
    && (adapter.id !== 'kanban' || Boolean(field.options?.length))
  ))
  const configuredFieldId = config.presentation.settings[adapter.settingKey]
  const field = typeof configuredFieldId === 'string'
    ? compatibleFields.find(candidate => candidate.id === configuredFieldId)
    : undefined
  return field
    ? { status: 'ready', adapterId: adapter.id, field }
    : { status: 'empty', adapterId: adapter.id, settingKey: adapter.settingKey, compatibleFields }
}

interface PendingObjectKanbanMove {
  operationId: string
  fieldId: string
  originalValue: WorkspaceObjectValue | undefined
  nextValue: WorkspaceObjectValue
  commitRevision?: number
}

export interface ObjectKanbanMoveState {
  pending: Record<string, PendingObjectKanbanMove>
  errors: Record<string, ObjectKanbanError>
  warnings: Record<string, ObjectKanbanWarning>
}

export type ObjectKanbanErrorCode = 'commit-missing' | 'canonical-mismatch' | 'transport'

export interface ObjectKanbanError {
  code: ObjectKanbanErrorCode
  detail?: string
}

export interface ObjectKanbanWarning {
  code: 'projection-error'
  revision: number
}

export const EMPTY_OBJECT_KANBAN_MOVE_STATE: ObjectKanbanMoveState = { pending: {}, errors: {}, warnings: {} }

export function beginObjectKanbanMove(
  state: ObjectKanbanMoveState,
  entry: WorkspaceObjectEntry,
  fieldId: string,
  nextValue: WorkspaceObjectValue,
  operationId: string,
): ObjectKanbanMoveState {
  if (state.pending[entry.id]) return state
  const errors = { ...state.errors }
  const warnings = { ...state.warnings }
  delete errors[entry.id]
  delete warnings[entry.id]
  return {
    pending: {
      ...state.pending,
      [entry.id]: { operationId, fieldId, originalValue: entry.values[fieldId], nextValue },
    },
    errors,
    warnings,
  }
}

export function resolveObjectKanbanEntryValue(
  state: ObjectKanbanMoveState,
  entry: WorkspaceObjectEntry,
  fieldId: string,
): WorkspaceObjectValue | undefined {
  const pending = state.pending[entry.id]
  return pending?.fieldId === fieldId ? pending.nextValue : entry.values[fieldId]
}

export type ObjectKanbanCommitResult =
  | { status: 'awaiting-revalidation'; entryId: string; operationId: string; revision: number; warning?: ObjectKanbanWarning }
  | { status: 'rollback'; entryId: string; operationId: string; error: ObjectKanbanError }

export async function commitObjectKanbanMove(options: {
  objectId: string
  entry: WorkspaceObjectEntry
  fieldId: string
  nextValue: WorkspaceObjectValue
  operationId: string
  mutate: MutateWorkspaceObject
}): Promise<ObjectKanbanCommitResult> {
  try {
    const result = await options.mutate({
      action: 'upsert-entries',
      objectId: options.objectId,
      entries: [{
        id: options.entry.id,
        values: { ...options.entry.values, [options.fieldId]: options.nextValue },
      }],
    })
    if (!('objectId' in result) || !('revision' in result) || result.objectId !== options.objectId) {
      return {
        status: 'rollback',
        entryId: options.entry.id,
        operationId: options.operationId,
        error: { code: 'commit-missing' },
      }
    }
    return {
      status: 'awaiting-revalidation',
      entryId: options.entry.id,
      operationId: options.operationId,
      revision: result.revision,
      ...(result.projectionStatus === 'projection-error'
        ? { warning: { code: 'projection-error' as const, revision: result.revision } }
        : {}),
    }
  } catch (error) {
    return {
      status: 'rollback',
      entryId: options.entry.id,
      operationId: options.operationId,
      error: { code: 'transport', detail: error instanceof Error ? error.message : String(error) },
    }
  }
}

export function applyObjectKanbanCommit(
  state: ObjectKanbanMoveState,
  result: ObjectKanbanCommitResult,
  latestPayload?: WorkspaceObjectPayload,
): ObjectKanbanMoveState {
  const pending = { ...state.pending }
  const move = pending[result.entryId]
  if (!move || move.operationId !== result.operationId) return state
  if (result.status === 'rollback') {
    delete pending[result.entryId]
    return { pending, errors: { ...state.errors, [result.entryId]: result.error }, warnings: state.warnings }
  }
  pending[result.entryId] = { ...move, commitRevision: result.revision }
  const warnings = { ...state.warnings }
  if (result.warning) warnings[result.entryId] = result.warning
  else delete warnings[result.entryId]
  const awaiting = { pending, errors: state.errors, warnings }
  return latestPayload ? reconcileObjectKanbanMoves(awaiting, latestPayload) : awaiting
}

export function reconcileObjectKanbanMoves(
  state: ObjectKanbanMoveState,
  payload: WorkspaceObjectPayload,
): ObjectKanbanMoveState {
  const pending = { ...state.pending }
  const errors = { ...state.errors }
  const warnings = { ...state.warnings }
  let changed = false
  if (payload.projectionStatus === 'ready') {
    for (const [entryId, warning] of Object.entries(warnings)) {
      if (payload.revision < warning.revision) continue
      delete warnings[entryId]
      changed = true
    }
  }
  for (const [entryId, move] of Object.entries(state.pending)) {
    if (move.commitRevision === undefined || payload.revision < move.commitRevision) continue
    const canonical = payload.entries.find(entry => entry.id === entryId)
    delete pending[entryId]
    changed = true
    if (canonical?.values[move.fieldId] !== move.nextValue) {
      errors[entryId] = { code: 'canonical-mismatch' }
    } else {
      delete errors[entryId]
    }
  }
  return changed ? { pending, errors, warnings } : state
}

const OBJECT_KANBAN_ERROR_KEYS: Record<ObjectKanbanErrorCode, string> = {
  'commit-missing': 'chat.workspaceObjectKanbanCommitMissing',
  'canonical-mismatch': 'chat.workspaceObjectKanbanNotConfirmed',
  transport: 'chat.workspaceObjectKanbanTransportError',
}

export function ObjectKanbanErrorAlert({
  error,
  entryId,
}: {
  error: ObjectKanbanError
  entryId?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      data-object-kanban-error-entry={entryId}
      className="mb-3 rounded border border-destructive/40 p-2 text-xs text-destructive"
      role="alert"
    >
      <div>{t(OBJECT_KANBAN_ERROR_KEYS[error.code])}</div>
      {error.detail ? <div className="mt-1 break-words text-[11px] opacity-80">{error.detail}</div> : null}
    </div>
  )
}

export function ObjectKanbanErrorAlerts({ errors }: { errors: Record<string, ObjectKanbanError> }) {
  return Object.entries(errors).map(([entryId, error]) => (
    <ObjectKanbanErrorAlert key={entryId} entryId={entryId} error={error} />
  ))
}

export function ObjectKanbanWarningAlerts({ warnings }: { warnings: Record<string, ObjectKanbanWarning> }) {
  const { t } = useTranslation()
  return Object.keys(warnings).map(entryId => (
    <div
      key={entryId}
      data-object-kanban-warning-entry={entryId}
      className="mb-3 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300"
      role="status"
    >
      {t('chat.workspaceObjectKanbanProjectionError')}
    </div>
  ))
}

function displayText(value: WorkspaceObjectValue | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function entryTitle(query: WorkspaceObjectQueryResult, entry: WorkspaceObjectEntry, field?: WorkspaceObjectField | null): string {
  const selected = field ?? query.fields[0]
  return selected ? displayText(query.displayValues.get(entry.id)?.[selected.id]) : entry.id
}

function ObjectEntrySummary({
  entry,
  query,
  headingField,
}: {
  entry: WorkspaceObjectEntry
  query: WorkspaceObjectQueryResult
  headingField?: WorkspaceObjectField | null
}) {
  return (
    <article data-entry-id={entry.id} className="rounded border border-foreground/10 bg-background p-3">
      <div className="text-sm font-medium">{entryTitle(query, entry, headingField)}</div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        {query.fields.map(field => field.id === headingField?.id ? null : (
          <div key={field.id} className="flex justify-between gap-3">
            <dt>{field.name}</dt>
            <dd className="truncate text-foreground/80">{displayText(query.displayValues.get(entry.id)?.[field.id])}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

function ObjectViewEmptyState({
  configuration,
  onConfigureSetting,
  onChangeAdapter,
}: {
  configuration: Extract<ObjectViewConfiguration, { status: 'empty' }>
  onConfigureSetting: (settingKey: string, fieldId: string) => void
  onChangeAdapter: (adapter: ObjectViewAdapterId) => void
}) {
  const { t } = useTranslation()
  const [fieldId, setFieldId] = React.useState(configuration.compatibleFields[0]?.id ?? '')
  const hasCompatibleField = configuration.compatibleFields.length > 0
  return (
    <div
      data-object-view-empty={configuration.adapterId}
      className="rounded border border-dashed border-foreground/20 p-4 text-sm"
    >
      <p className="text-muted-foreground">
        {t(hasCompatibleField ? 'chat.workspaceObjectAdapterMissingField' : 'chat.workspaceObjectAdapterNoCompatibleField')}
      </p>
      {hasCompatibleField ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            className="h-8 rounded border border-foreground/15 bg-background px-2 text-xs"
            value={fieldId}
            aria-label={t('chat.workspaceObjectConfigureField')}
            onChange={event => setFieldId(event.target.value)}
          >
            {configuration.compatibleFields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select>
          <Button type="button" size="sm" onClick={() => onConfigureSetting(configuration.settingKey, fieldId)}>
            {t('chat.workspaceObjectConfigureView')}
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" className="mt-3" onClick={() => onChangeAdapter('table')}>
          {t('chat.workspaceObjectAdapterUseTable')}
        </Button>
      )}
    </div>
  )
}

function ObjectListView({ query, field }: { query: WorkspaceObjectQueryResult; field: WorkspaceObjectField }) {
  return <div className="space-y-2">{query.entries.map(entry => <ObjectEntrySummary key={entry.id} entry={entry} query={query} headingField={field} />)}</div>
}

function ObjectCalendarView({ query, field }: { query: WorkspaceObjectQueryResult; field: WorkspaceObjectField }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {query.entries.map(entry => (
        <div key={entry.id} data-entry-id={entry.id} className="rounded border border-foreground/10 p-3">
          <time className="text-xs font-medium text-muted-foreground">{displayText(query.displayValues.get(entry.id)?.[field.id])}</time>
          <div className="mt-1 text-sm font-medium">{entryTitle(query, entry)}</div>
        </div>
      ))}
    </div>
  )
}

function ObjectTimelineView({ query, field }: { query: WorkspaceObjectQueryResult; field: WorkspaceObjectField }) {
  return (
    <ol className="space-y-3 border-l border-foreground/15 pl-4">
      {query.entries.map(entry => (
        <li key={entry.id} data-entry-id={entry.id} className="relative">
          <span className="absolute -left-[1.2rem] top-1.5 h-2 w-2 rounded-full bg-foreground/50" />
          <time className="text-xs text-muted-foreground">{displayText(query.displayValues.get(entry.id)?.[field.id])}</time>
          <div className="text-sm font-medium">{entryTitle(query, entry)}</div>
        </li>
      ))}
    </ol>
  )
}

function ObjectGalleryView({ query, field }: { query: WorkspaceObjectQueryResult; field: WorkspaceObjectField }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {query.entries.map(entry => (
        <article key={entry.id} data-entry-id={entry.id} className="overflow-hidden rounded border border-foreground/10">
          <div className="flex aspect-video items-center justify-center bg-muted px-3 text-center text-xs text-muted-foreground">
            {displayText(query.displayValues.get(entry.id)?.[field.id])}
          </div>
          <div className="p-3 text-sm font-medium">{entryTitle(query, entry)}</div>
        </article>
      ))}
    </div>
  )
}

const OBJECT_KANBAN_ENTRY_PREFIX = 'object-kanban-entry:'
const OBJECT_KANBAN_COLUMN_PREFIX = 'object-kanban-column:option:'
const OBJECT_KANBAN_NO_GROUP_ID = 'object-kanban-column:no-group'

function objectKanbanEntryId(entryId: string): string {
  return `${OBJECT_KANBAN_ENTRY_PREFIX}${entryId}`
}

export const OBJECT_KANBAN_KEYBOARD_SENSOR = KeyboardSensor

function isObjectKanbanColumnId(id: unknown): id is string {
  return typeof id === 'string'
    && (id === OBJECT_KANBAN_NO_GROUP_ID || id.startsWith(OBJECT_KANBAN_COLUMN_PREFIX))
}

export const OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER: KeyboardCoordinateGetter = (
  event,
  { context, currentCoordinates },
) => {
  if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) return undefined
  const sourceColumnId = context.active?.data.current?.objectKanbanColumnId
  const enabledContainers = context.droppableContainers.getEnabled()
  let currentColumnId = sourceColumnId
  if (isObjectKanbanColumnId(context.over?.id)) {
    for (const container of enabledContainers) {
      if (container.id === context.over.id) {
        currentColumnId = context.over.id
        break
      }
    }
  }
  const columns: Array<{ rect: NonNullable<ReturnType<typeof context.droppableRects.get>> }> = []
  for (const container of enabledContainers) {
    if (!isObjectKanbanColumnId(container.id)) continue
    if (container.id === currentColumnId) continue
    const rect = context.droppableRects.get(container.id)
    if (!rect) continue
    const isAhead = event.code === KeyboardCode.Right
      ? rect.left > currentCoordinates.x
      : rect.left < currentCoordinates.x
    if (isAhead) columns.push({ rect })
  }
  columns.sort((left, right) => event.code === KeyboardCode.Right
    ? left.rect.left - right.rect.left
    : right.rect.left - left.rect.left)
  const target = columns[0]
  if (!target) return undefined
  event.preventDefault()
  return { x: target.rect.left, y: target.rect.top }
}

export function resolveObjectKanbanDropValue(
  field: WorkspaceObjectField,
  dropId: string,
): string | null | undefined {
  if (dropId === OBJECT_KANBAN_NO_GROUP_ID) return field.required ? undefined : null
  if (!dropId.startsWith(OBJECT_KANBAN_COLUMN_PREFIX)) return undefined
  const indexText = dropId.slice(OBJECT_KANBAN_COLUMN_PREFIX.length)
  if (!/^(0|[1-9]\d*)$/.test(indexText)) return undefined
  return field.options?.[Number(indexText)]
}

interface ObjectKanbanColumnModel {
  id: string
  value: string | null
  label: string
  entries: WorkspaceObjectEntry[]
  disabled: boolean
}

function buildObjectKanbanColumns(
  field: WorkspaceObjectField,
  query: WorkspaceObjectQueryResult,
  moveState: ObjectKanbanMoveState,
  noGroupLabel: string,
): ObjectKanbanColumnModel[] {
  const optionColumns: ObjectKanbanColumnModel[] = (field.options ?? []).map((value, index) => ({
    id: `${OBJECT_KANBAN_COLUMN_PREFIX}${index}`,
    value,
    label: value,
    entries: [],
    disabled: false,
  }))
  const noGroupColumn: ObjectKanbanColumnModel = {
    id: OBJECT_KANBAN_NO_GROUP_ID,
    value: null,
    label: noGroupLabel,
    entries: [],
    disabled: field.required === true,
  }
  const columnByValue = new Map(optionColumns.map(column => [column.value, column]))
  for (const entry of query.entries) {
    const value = resolveObjectKanbanEntryValue(moveState, entry, field.id)
    const column = typeof value === 'string' ? columnByValue.get(value) : undefined
    const targetColumn = column ?? noGroupColumn
    targetColumn.entries.push(entry)
  }
  return [...optionColumns, noGroupColumn]
}

function ObjectKanbanCard({
  entry,
  query,
  pending,
  columnId,
}: {
  entry: WorkspaceObjectEntry
  query: WorkspaceObjectQueryResult
  pending: boolean
  columnId: string
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: objectKanbanEntryId(entry.id),
    disabled: pending,
    data: { objectKanbanColumnId: columnId },
  })
  return (
    <div
      ref={setNodeRef}
      data-entry-id={entry.id}
      className={`rounded border border-foreground/10 bg-background p-3 text-sm font-medium shadow-sm ${pending ? 'cursor-wait opacity-60' : 'cursor-grab'} ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      {entryTitle(query, entry)}
    </div>
  )
}

function ObjectKanbanColumn({
  column,
  query,
  pendingEntryIds,
}: {
  column: ObjectKanbanColumnModel
  query: WorkspaceObjectQueryResult
  pendingEntryIds: Set<string>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: column.disabled })
  return (
    <section
      ref={setNodeRef}
      data-object-kanban-column-id={column.id}
      data-object-kanban-column-disabled={column.disabled}
      role="group"
      aria-disabled={column.disabled}
      className={`min-w-56 flex-1 rounded border p-2 ${column.disabled ? 'opacity-60' : ''} ${isOver ? 'border-primary bg-primary/5' : 'border-foreground/10'}`}
    >
      <header className="mb-2 flex items-center justify-between text-xs font-semibold">
        <span>{column.label}</span>
        <span className="text-muted-foreground">{column.entries.length}</span>
      </header>
      <div className="space-y-2">
        {column.entries.map(entry => (
          <ObjectKanbanCard
            key={entry.id}
            entry={entry}
            query={query}
            pending={pendingEntryIds.has(entry.id)}
            columnId={column.id}
          />
        ))}
      </div>
    </section>
  )
}

function ObjectKanbanView({
  payload,
  query,
  field,
  mutate,
}: {
  payload: WorkspaceObjectPayload
  query: WorkspaceObjectQueryResult
  field: WorkspaceObjectField
  mutate: MutateWorkspaceObject
}) {
  const { t } = useTranslation()
  const [moveState, setMoveState] = React.useState<ObjectKanbanMoveState>(EMPTY_OBJECT_KANBAN_MOVE_STATE)
  const pendingOperationsRef = React.useRef(new Map<string, string>())
  const latestPayloadRef = React.useRef(payload)
  const sensors = useSensors(
    useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(OBJECT_KANBAN_KEYBOARD_SENSOR, { coordinateGetter: OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER }),
  )
  const columns = buildObjectKanbanColumns(field, query, moveState, t('chat.workspaceObjectKanbanNoGroup'))
  const pendingEntryIds = new Set(Object.keys(moveState.pending))

  React.useLayoutEffect(() => {
    latestPayloadRef.current = payload
  }, [payload])

  React.useEffect(() => {
    pendingOperationsRef.current = new Map(
      Object.entries(moveState.pending).map(([entryId, move]) => [entryId, move.operationId]),
    )
  }, [moveState.pending])

  React.useEffect(() => {
    setMoveState(current => reconcileObjectKanbanMoves(current, payload))
  }, [payload])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    if (!event.over) return
    const activeId = String(event.active.id)
    const entry = query.entries.find(candidate => objectKanbanEntryId(candidate.id) === activeId)
    const nextValue = resolveObjectKanbanDropValue(field, String(event.over.id))
    if (!entry || nextValue === undefined || pendingOperationsRef.current.has(entry.id)) return
    if (resolveObjectKanbanEntryValue(moveState, entry, field.id) === nextValue) return
    const operationId = crypto.randomUUID()
    pendingOperationsRef.current.set(entry.id, operationId)
    setMoveState(current => beginObjectKanbanMove(current, entry, field.id, nextValue, operationId))
    void commitObjectKanbanMove({ objectId: payload.id, entry, fieldId: field.id, nextValue, operationId, mutate })
      .then(result => setMoveState(current => applyObjectKanbanCommit(current, result, latestPayloadRef.current)))
  }, [field, moveState, mutate, payload.id, query.entries])

  return (
    <div>
      <ObjectKanbanErrorAlerts errors={moveState.errors} />
      <ObjectKanbanWarningAlerts warnings={moveState.warnings} />
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map(column => (
            <ObjectKanbanColumn
              key={column.id}
              column={column}
              query={query}
              pendingEntryIds={pendingEntryIds}
            />
          ))}
        </div>
      </DndContext>
    </div>
  )
}

export function ObjectViewHost({
  payload,
  config,
  query,
  mutate,
  tableContent,
  onConfigureSetting,
  onChangeAdapter,
}: {
  payload: WorkspaceObjectPayload
  config: WorkspaceObjectViewConfig
  query: WorkspaceObjectQueryResult
  mutate: MutateWorkspaceObject
  tableContent: React.ReactNode
  onConfigureSetting: (settingKey: string, fieldId: string) => void
  onChangeAdapter: (adapter: ObjectViewAdapterId) => void
}) {
  const configuration = resolveObjectViewConfiguration(payload, config)
  if (configuration.status === 'empty') {
    return (
      <ObjectViewEmptyState
        key={`${configuration.adapterId}:${configuration.settingKey}`}
        configuration={configuration}
        onConfigureSetting={onConfigureSetting}
        onChangeAdapter={onChangeAdapter}
      />
    )
  }
  const field = configuration.field
  return (
    <div data-object-adapter={configuration.adapterId} data-object-id={payload.id} data-object-revision={payload.revision}>
      {configuration.adapterId === 'table' ? tableContent : null}
      {configuration.adapterId === 'kanban' && field ? <ObjectKanbanView payload={payload} query={query} field={field} mutate={mutate} /> : null}
      {configuration.adapterId === 'calendar' && field ? <ObjectCalendarView query={query} field={field} /> : null}
      {configuration.adapterId === 'timeline' && field ? <ObjectTimelineView query={query} field={field} /> : null}
      {configuration.adapterId === 'gallery' && field ? <ObjectGalleryView query={query} field={field} /> : null}
      {configuration.adapterId === 'list' && field ? <ObjectListView query={query} field={field} /> : null}
    </div>
  )
}
