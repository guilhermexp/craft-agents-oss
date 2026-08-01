import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  fieldId: string
  originalValue: WorkspaceObjectValue | undefined
  nextValue: WorkspaceObjectValue
  commitRevision?: number
}

export interface ObjectKanbanMoveState {
  pending: Record<string, PendingObjectKanbanMove>
  error: string | null
}

export const EMPTY_OBJECT_KANBAN_MOVE_STATE: ObjectKanbanMoveState = { pending: {}, error: null }

export function beginObjectKanbanMove(
  state: ObjectKanbanMoveState,
  entry: WorkspaceObjectEntry,
  fieldId: string,
  nextValue: WorkspaceObjectValue,
): ObjectKanbanMoveState {
  return {
    pending: {
      ...state.pending,
      [entry.id]: { fieldId, originalValue: entry.values[fieldId], nextValue },
    },
    error: null,
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
  | { status: 'awaiting-revalidation'; entryId: string; revision: number }
  | { status: 'rollback'; entryId: string; error: string }

export async function commitObjectKanbanMove(options: {
  objectId: string
  entry: WorkspaceObjectEntry
  fieldId: string
  nextValue: WorkspaceObjectValue
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
      return { status: 'rollback', entryId: options.entry.id, error: 'The Kanban move did not return a canonical commit.' }
    }
    if (result.projectionStatus !== 'ready') {
      return { status: 'rollback', entryId: options.entry.id, error: 'The Kanban move committed but its projection requires repair.' }
    }
    return { status: 'awaiting-revalidation', entryId: options.entry.id, revision: result.revision }
  } catch (error) {
    return {
      status: 'rollback',
      entryId: options.entry.id,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function applyObjectKanbanCommit(
  state: ObjectKanbanMoveState,
  result: ObjectKanbanCommitResult,
): ObjectKanbanMoveState {
  const pending = { ...state.pending }
  const move = pending[result.entryId]
  if (result.status === 'rollback') {
    delete pending[result.entryId]
    return { pending, error: result.error }
  }
  if (!move) return state
  pending[result.entryId] = { ...move, commitRevision: result.revision }
  return { pending, error: null }
}

export function reconcileObjectKanbanMoves(
  state: ObjectKanbanMoveState,
  payload: WorkspaceObjectPayload,
): ObjectKanbanMoveState {
  const pending = { ...state.pending }
  let error = state.error
  let changed = false
  for (const [entryId, move] of Object.entries(state.pending)) {
    if (move.commitRevision === undefined || payload.revision < move.commitRevision) continue
    const canonical = payload.entries.find(entry => entry.id === entryId)
    delete pending[entryId]
    changed = true
    if (canonical?.values[move.fieldId] !== move.nextValue) {
      error = 'The Kanban move could not be confirmed after refresh.'
    }
  }
  return changed ? { pending, error } : state
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
}: {
  configuration: Extract<ObjectViewConfiguration, { status: 'empty' }>
  onConfigureSetting: (settingKey: string, fieldId: string) => void
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
      ) : null}
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

function ObjectKanbanCard({ entry, query }: { entry: WorkspaceObjectEntry; query: WorkspaceObjectQueryResult }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: entry.id })
  return (
    <div
      ref={setNodeRef}
      data-entry-id={entry.id}
      className={`cursor-grab rounded border border-foreground/10 bg-background p-3 text-sm font-medium shadow-sm ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      {entryTitle(query, entry)}
    </div>
  )
}

function ObjectKanbanColumn({
  value,
  entries,
  query,
}: {
  value: string
  entries: WorkspaceObjectEntry[]
  query: WorkspaceObjectQueryResult
}) {
  const { setNodeRef, isOver } = useDroppable({ id: value })
  return (
    <section ref={setNodeRef} className={`min-w-56 flex-1 rounded border p-2 ${isOver ? 'border-primary bg-primary/5' : 'border-foreground/10'}`}>
      <header className="mb-2 flex items-center justify-between text-xs font-semibold">
        <span>{value}</span>
        <span className="text-muted-foreground">{entries.length}</span>
      </header>
      <div className="space-y-2">{entries.map(entry => <ObjectKanbanCard key={entry.id} entry={entry} query={query} />)}</div>
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
  const [moveState, setMoveState] = React.useState<ObjectKanbanMoveState>(EMPTY_OBJECT_KANBAN_MOVE_STATE)
  const sensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }))
  const values = field.options ?? []

  React.useEffect(() => {
    setMoveState(current => reconcileObjectKanbanMoves(current, payload))
  }, [payload])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    if (!event.over) return
    const entry = query.entries.find(candidate => candidate.id === String(event.active.id))
    const nextValue = String(event.over.id)
    if (!entry || resolveObjectKanbanEntryValue(moveState, entry, field.id) === nextValue) return
    setMoveState(current => beginObjectKanbanMove(current, entry, field.id, nextValue))
    void commitObjectKanbanMove({ objectId: payload.id, entry, fieldId: field.id, nextValue, mutate })
      .then(result => setMoveState(current => applyObjectKanbanCommit(current, result)))
  }, [field.id, moveState, mutate, payload.id, query.entries])

  const entriesByValue = new Map(values.map(value => [value, [] as WorkspaceObjectEntry[]]))
  for (const entry of query.entries) {
    const value = resolveObjectKanbanEntryValue(moveState, entry, field.id)
    if (typeof value === 'string') entriesByValue.get(value)?.push(entry)
  }

  return (
    <div>
      {moveState.error ? <div className="mb-3 rounded border border-destructive/40 p-2 text-xs text-destructive" role="alert">{moveState.error}</div> : null}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {values.map(value => <ObjectKanbanColumn key={value} value={value} entries={entriesByValue.get(value) ?? []} query={query} />)}
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
}: {
  payload: WorkspaceObjectPayload
  config: WorkspaceObjectViewConfig
  query: WorkspaceObjectQueryResult
  mutate: MutateWorkspaceObject
  tableContent: React.ReactNode
  onConfigureSetting: (settingKey: string, fieldId: string) => void
}) {
  const configuration = resolveObjectViewConfiguration(payload, config)
  if (configuration.status === 'empty') {
    return (
      <ObjectViewEmptyState
        key={`${configuration.adapterId}:${configuration.settingKey}`}
        configuration={configuration}
        onConfigureSetting={onConfigureSetting}
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
