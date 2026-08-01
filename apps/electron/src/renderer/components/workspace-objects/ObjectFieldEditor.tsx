import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import {
  WORKSPACE_OBJECT_VALUE_MAX_LENGTH,
  type WorkspaceObjectField,
  type WorkspaceObjectValue,
} from '@craft-agent/shared/workspace-objects/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type ObjectFieldEditState =
  | { status: 'idle' }
  | { status: 'editing'; draft: string; error: string | null }
  | { status: 'submitting'; draft: string; error: null }
  | { status: 'awaiting-revalidation'; draft: string; revision: number; value: WorkspaceObjectValue; error: null }

export type ObjectFieldParseResult =
  | { success: true; value: WorkspaceObjectValue }
  | { success: false; error: string }

export interface ObjectRelationOption {
  id: string
  label: string
}

export const OBJECT_FIELD_SAVING_TRANSLATION_KEY = 'chat.workspaceObjectSavingField' as const

const EMPTY_RELATION_OPTIONS: ObjectRelationOption[] = []
const EMPTY_RELATION_LABELS: ReadonlyMap<string, string> = new Map()

type MutateWorkspaceObject = (action: WorkspaceObjectAction) => Promise<WorkspaceObjectServiceResult>
type ObjectFieldErrorKey =
  | 'chat.workspaceObjectFieldRequired'
  | 'chat.workspaceObjectFieldFiniteNumber'
  | 'chat.workspaceObjectFieldBoolean'
  | 'chat.workspaceObjectFieldDate'
  | 'chat.workspaceObjectFieldDatetime'
  | 'chat.workspaceObjectFieldOption'
  | 'chat.workspaceObjectFieldRelation'
  | 'chat.workspaceObjectFieldFile'
  | 'chat.workspaceObjectFieldTooLong'
  | 'chat.workspaceObjectCommitMissing'
  | 'chat.workspaceObjectEditNotCommitted'
  | 'chat.workspaceObjectEditNotConfirmed'
type ObjectFieldErrorFormatter = (key: ObjectFieldErrorKey, values?: Record<string, string>) => string

const defaultErrorFormatter: ObjectFieldErrorFormatter = (key, values = {}) => {
  const field = values.field ?? 'Field'
  const message = values.message ?? ''
  const messages: Record<ObjectFieldErrorKey, string> = {
    'chat.workspaceObjectFieldRequired': `${field} is required.`,
    'chat.workspaceObjectFieldFiniteNumber': `${field} must be a finite number.`,
    'chat.workspaceObjectFieldBoolean': `${field} must be true or false.`,
    'chat.workspaceObjectFieldDate': `${field} must be a real date in YYYY-MM-DD format.`,
    'chat.workspaceObjectFieldDatetime': `${field} must be an ISO datetime with a timezone.`,
    'chat.workspaceObjectFieldOption': `Choose a supported ${field} option.`,
    'chat.workspaceObjectFieldRelation': `Choose an existing ${field} relation.`,
    'chat.workspaceObjectFieldFile': `${field} contains an invalid file path.`,
    'chat.workspaceObjectFieldTooLong': `${field} cannot exceed ${WORKSPACE_OBJECT_VALUE_MAX_LENGTH} characters.`,
    'chat.workspaceObjectCommitMissing': 'The mutation did not return a canonical commit.',
    'chat.workspaceObjectEditNotCommitted': `The edit was not committed: ${message}`,
    'chat.workspaceObjectEditNotConfirmed': 'The committed value could not be confirmed after refresh. Review the current value and retry.',
  }
  return messages[key]
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value))
}

export function parseObjectFieldDraft(
  field: WorkspaceObjectField,
  draft: string,
  validRelationIds: ReadonlySet<string> = new Set(),
  formatError: ObjectFieldErrorFormatter = defaultErrorFormatter,
): ObjectFieldParseResult {
  if (draft === '' && !field.required) return { success: true, value: null }
  if (field.required && draft.trim() === '') return { success: false, error: formatError('chat.workspaceObjectFieldRequired', { field: field.name }) }
  if (draft.length > WORKSPACE_OBJECT_VALUE_MAX_LENGTH) {
    return { success: false, error: formatError('chat.workspaceObjectFieldTooLong', { field: field.name }) }
  }

  if (field.type === 'number') {
    const value = Number(draft)
    return Number.isFinite(value)
      ? { success: true, value }
      : { success: false, error: formatError('chat.workspaceObjectFieldFiniteNumber', { field: field.name }) }
  }
  if (field.type === 'boolean') {
    if (draft === 'true') return { success: true, value: true }
    if (draft === 'false') return { success: true, value: false }
    return { success: false, error: formatError('chat.workspaceObjectFieldBoolean', { field: field.name }) }
  }
  if (field.type === 'date' && !isValidDate(draft)) {
    return { success: false, error: formatError('chat.workspaceObjectFieldDate', { field: field.name }) }
  }
  if (field.type === 'datetime' && !isIsoDateTime(draft)) {
    return { success: false, error: formatError('chat.workspaceObjectFieldDatetime', { field: field.name }) }
  }
  if ((field.type === 'select' || field.type === 'status') && !field.options?.includes(draft)) {
    return { success: false, error: formatError('chat.workspaceObjectFieldOption', { field: field.name }) }
  }
  if (field.type === 'relation' && !validRelationIds.has(draft)) {
    return { success: false, error: formatError('chat.workspaceObjectFieldRelation', { field: field.name }) }
  }
  if (field.type === 'file' && draft.includes('\0')) {
    return { success: false, error: formatError('chat.workspaceObjectFieldFile', { field: field.name }) }
  }
  return { success: true, value: draft }
}

export function resolveObjectFieldDisplayValue(
  field: WorkspaceObjectField,
  value: WorkspaceObjectValue | undefined,
  relationLabels: ReadonlyMap<string, string> = new Map(),
): string {
  if (value === null || value === undefined) return ''
  if (field.type === 'relation' && typeof value === 'string') return relationLabels.get(value) ?? value
  if (field.type === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export async function submitObjectFieldEdit(options: {
  state: ObjectFieldEditState
  field: WorkspaceObjectField
  objectId: string
  entryId: string
  currentValues: Record<string, WorkspaceObjectValue>
  validRelationIds?: ReadonlySet<string>
  mutate: MutateWorkspaceObject
  formatError?: ObjectFieldErrorFormatter
}): Promise<ObjectFieldEditState> {
  if (options.state.status !== 'editing') return options.state
  const formatError = options.formatError ?? defaultErrorFormatter
  const parsed = parseObjectFieldDraft(options.field, options.state.draft, options.validRelationIds, formatError)
  if (!parsed.success) return { ...options.state, error: parsed.error }

  try {
    const result = await options.mutate({
      action: 'upsert-entries',
      objectId: options.objectId,
      entries: [{
        id: options.entryId,
        values: { ...options.currentValues, [options.field.id]: parsed.value },
      }],
    })
    if (!('objectId' in result) || !('revision' in result) || result.objectId !== options.objectId) {
      return { status: 'editing', draft: options.state.draft, error: formatError('chat.workspaceObjectCommitMissing') }
    }
    return {
      status: 'awaiting-revalidation',
      draft: options.state.draft,
      revision: result.revision,
      value: parsed.value,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'editing', draft: options.state.draft, error: formatError('chat.workspaceObjectEditNotCommitted', { message }) }
  }
}

export function reconcileObjectFieldEdit(
  state: ObjectFieldEditState,
  payloadRevision: number,
  canonicalValue: WorkspaceObjectValue | undefined,
  formatError: ObjectFieldErrorFormatter = defaultErrorFormatter,
): ObjectFieldEditState {
  if (state.status !== 'awaiting-revalidation' || payloadRevision < state.revision) return state
  if (canonicalValue === state.value) return { status: 'idle' }
  return {
    status: 'editing',
    draft: state.draft,
    error: formatError('chat.workspaceObjectEditNotConfirmed'),
  }
}

function valueToDraft(field: WorkspaceObjectField, value: WorkspaceObjectValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (field.type === 'datetime' && typeof value === 'string') return value
  return String(value)
}

export interface ObjectFieldEditorProps {
  objectId: string
  entryId: string
  field: WorkspaceObjectField
  value: WorkspaceObjectValue | undefined
  currentValues: Record<string, WorkspaceObjectValue>
  payloadRevision: number
  relationOptions?: ObjectRelationOption[]
  relationLabels?: ReadonlyMap<string, string>
  hasMoreRelationOptions?: boolean
  loadingRelationOptions?: boolean
  onLoadMoreRelationOptions?: () => void
  mutate: MutateWorkspaceObject
}

export function ObjectFieldEditor({
  objectId,
  entryId,
  field,
  value,
  currentValues,
  payloadRevision,
  relationOptions = EMPTY_RELATION_OPTIONS,
  relationLabels = EMPTY_RELATION_LABELS,
  hasMoreRelationOptions = false,
  loadingRelationOptions = false,
  onLoadMoreRelationOptions,
  mutate,
}: ObjectFieldEditorProps) {
  const { t } = useTranslation()
  const formatError = React.useCallback<ObjectFieldErrorFormatter>((key, values) => t(key, values), [t])
  const [state, setState] = React.useState<ObjectFieldEditState>({ status: 'idle' })
  const validRelationIds = React.useMemo(() => new Set(relationOptions.map(option => option.id)), [relationOptions])
  const latestCanonicalRef = React.useRef({ payloadRevision, value })
  const editing = state.status !== 'idle'
  const busy = state.status === 'submitting' || state.status === 'awaiting-revalidation'

  React.useLayoutEffect(() => {
    latestCanonicalRef.current = { payloadRevision, value }
  }, [payloadRevision, value])

  React.useEffect(() => {
    setState(current => reconcileObjectFieldEdit(current, payloadRevision, value, formatError))
  }, [payloadRevision, value, formatError])

  const updateDraft = (draft: string) => {
    setState(current => current.status === 'idle' ? current : { status: 'editing', draft, error: null })
  }

  const submit = async () => {
    if (state.status !== 'editing') return
    const editingState = state
    setState({ status: 'submitting', draft: state.draft, error: null })
    const next = await submitObjectFieldEdit({
      state: editingState,
      field,
      objectId,
      entryId,
      currentValues,
      validRelationIds,
      mutate,
      formatError,
    })
    const latest = latestCanonicalRef.current
    setState(reconcileObjectFieldEdit(next, latest.payloadRevision, latest.value, formatError))
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="min-h-7 w-full rounded px-1.5 text-left text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setState({ status: 'editing', draft: valueToDraft(field, value), error: null })}
      >
        {resolveObjectFieldDisplayValue(field, value, relationLabels) || <span className="text-muted-foreground/50">—</span>}
      </button>
    )
  }

  const draft = state.draft
  const error = state.error
  const input = field.type === 'select' || field.type === 'status' || field.type === 'relation' || field.type === 'boolean' ? (
    <select
      className="h-8 w-full rounded border border-foreground/15 bg-background px-2 text-xs"
      value={draft}
      disabled={busy}
      onChange={event => updateDraft(event.target.value)}
      aria-label={field.name}
    >
      {!field.required ? <option value="">—</option> : null}
      {field.type === 'boolean' ? (
        <>
          <option value="true">true</option>
          <option value="false">false</option>
        </>
      ) : field.type === 'relation' ? relationOptions.map(option => (
        <option key={option.id} value={option.id}>{option.label}</option>
      )) : field.options?.map(option => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  ) : (
    <Input
      className="h-8 text-xs"
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={draft}
      disabled={busy}
      onChange={event => updateDraft(event.target.value)}
      aria-label={field.name}
      autoFocus
    />
  )

  return (
    <div className="min-w-36 space-y-1.5">
      {input}
      {field.type === 'relation' && hasMoreRelationOptions && onLoadMoreRelationOptions ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={loadingRelationOptions} onClick={onLoadMoreRelationOptions}>
          {loadingRelationOptions ? t('common.loading') : t('common.more')}
        </Button>
      ) : null}
      {error ? <div className="text-[11px] text-destructive" role="alert">{error}</div> : null}
      <div className="flex gap-1">
        <Button type="button" size="sm" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void submit()}>
          {busy ? t(OBJECT_FIELD_SAVING_TRANSLATION_KEY) : t('common.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => setState({ status: 'idle' })}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
