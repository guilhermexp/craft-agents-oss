import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { KeyboardSensor } from '@dnd-kit/core'
import { evaluateWorkspaceObjectQuery } from '@craft-agent/shared/workspace-objects/query'
import type { WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import type { WorkspaceObjectViewConfig } from '@craft-agent/shared/workspace-objects/view-schema'
import {
  EMPTY_OBJECT_KANBAN_MOVE_STATE,
  OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER,
  OBJECT_KANBAN_KEYBOARD_SENSOR,
  OBJECT_VIEW_ADAPTERS,
  ObjectKanbanErrorAlert,
  ObjectKanbanErrorAlerts,
  ObjectViewHost,
  applyObjectKanbanCommit,
  beginObjectKanbanMove,
  commitObjectKanbanMove,
  getObjectViewAdapter,
  reconcileObjectKanbanMoves,
  resolveObjectKanbanDropValue,
  resolveObjectKanbanEntryValue,
  resolveObjectViewConfiguration,
  withObjectViewAdapter,
  type ObjectKanbanErrorCode,
} from '../ObjectViewHost'

const payload: WorkspaceObjectPayload = {
  id: 'object_people',
  slug: 'people',
  name: 'People',
  revision: 4,
  projectionStatus: 'ready',
  fields: [
    { id: 'field_name', name: 'Name', type: 'text' },
    { id: 'field_status', name: 'Status', type: 'status', options: ['Todo', 'Doing'] },
    { id: 'field_date', name: 'Date', type: 'date' },
    { id: 'field_file', name: 'File', type: 'file' },
  ],
  entries: [
    { id: 'entry_a', values: { field_name: 'Ada', field_status: 'Todo', field_date: '2026-08-01', field_file: 'ada.png' } },
    { id: 'entry_b', values: { field_name: 'Grace', field_status: 'Doing', field_date: '2026-08-02', field_file: 'grace.png' } },
  ],
  savedViews: [],
}

const adapterSettings: Record<WorkspaceObjectViewConfig['presentation']['adapter'], Record<string, string>> = {
  table: {},
  kanban: { groupFieldId: 'field_status' },
  calendar: { dateFieldId: 'field_date' },
  timeline: { dateFieldId: 'field_date' },
  gallery: { mediaFieldId: 'field_file' },
  list: { primaryFieldId: 'field_name' },
}

function config(adapter: WorkspaceObjectViewConfig['presentation']['adapter']): WorkspaceObjectViewConfig {
  return {
    schemaVersion: 1,
    search: '',
    filter: null,
    sort: [],
    columnVisibility: {},
    presentation: { adapter, settings: adapterSettings[adapter] },
  }
}

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'chat.workspaceObjectConfigureView': 'Configure view',
        'chat.workspaceObjectAdapterMissingField': 'Choose a compatible field for this view.',
        'chat.workspaceObjectAdapterNoCompatibleField': 'Add a compatible field before using this view.',
        'chat.workspaceObjectAdapterUseTable': 'Use table',
        'chat.workspaceObjectConfigureField': 'Field used by this view',
        'chat.workspaceObjectKanbanNoGroup': 'No group',
        'chat.workspaceObjectKanbanCommitMissing': 'The Kanban move did not return a canonical commit.',
        'chat.workspaceObjectKanbanProjectionError': 'The Kanban move committed but its projection requires repair.',
        'chat.workspaceObjectKanbanNotConfirmed': 'The Kanban move could not be confirmed after refresh.',
        'chat.workspaceObjectKanbanTransportError': 'The Kanban move could not be saved.',
      },
    },
  },
})

describe('object view adapter registry', () => {
  test('registers exactly the six U6 adapters and returns null for unknown lookup', () => {
    expect(OBJECT_VIEW_ADAPTERS.map(adapter => adapter.id)).toEqual([
      'table', 'kanban', 'calendar', 'timeline', 'gallery', 'list',
    ])
    expect(getObjectViewAdapter('kanban')?.id).toBe('kanban')
    expect(getObjectViewAdapter('unknown')).toBeNull()
  })

  test('returns an explicit configurable empty state for missing or incompatible settings', () => {
    const missing = resolveObjectViewConfiguration(payload, {
      ...config('kanban'),
      presentation: { adapter: 'kanban', settings: {} },
    })
    expect(missing).toMatchObject({
      status: 'empty',
      adapterId: 'kanban',
      settingKey: 'groupFieldId',
      compatibleFields: [{ id: 'field_status' }],
    })

    const incompatible = resolveObjectViewConfiguration(payload, {
      ...config('calendar'),
      presentation: { adapter: 'calendar', settings: { dateFieldId: 'field_name' } },
    })
    expect(incompatible).toMatchObject({ status: 'empty', adapterId: 'calendar', settingKey: 'dateFieldId' })
  })

  test('renders every adapter from the same query entries and stable ids', () => {
    for (const adapter of OBJECT_VIEW_ADAPTERS) {
      const viewConfig = config(adapter.id)
      const query = evaluateWorkspaceObjectQuery(payload, viewConfig)
      const markup = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <ObjectViewHost
            payload={payload}
            config={viewConfig}
            query={query}
            mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
            tableContent={(
              <div>
                {query.entries.map(entry => <div key={entry.id} data-entry-id={entry.id} />)}
              </div>
            )}
            onConfigureSetting={() => {}}
            onChangeAdapter={() => {}}
          />
        </I18nextProvider>,
      )
      expect(markup).toContain(`data-object-adapter="${adapter.id}"`)
      expect(markup).toContain('data-entry-id="entry_a"')
      expect(markup).toContain('data-entry-id="entry_b"')
    }
  })

  test('renders missing configuration with a clear configure action instead of fallback', () => {
    const viewConfig = { ...config('kanban'), presentation: { adapter: 'kanban' as const, settings: {} } }
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectViewHost
          payload={payload}
          config={viewConfig}
          query={evaluateWorkspaceObjectQuery(payload, viewConfig)}
          mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
          tableContent={<div>table must not render</div>}
          onConfigureSetting={() => {}}
          onChangeAdapter={() => {}}
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('data-object-view-empty="kanban"')
    expect(markup).toContain('Configure view')
    expect(markup).not.toContain('table must not render')
  })

  test('offers a localized table action when the adapter has no compatible field', () => {
    const noFilePayload = {
      ...payload,
      fields: payload.fields.filter(field => field.type !== 'file'),
    }
    const viewConfig = config('gallery')
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectViewHost
          payload={noFilePayload}
          config={viewConfig}
          query={evaluateWorkspaceObjectQuery(noFilePayload, viewConfig)}
          mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
          tableContent={<div>table must not render before the action</div>}
          onConfigureSetting={() => {}}
          onChangeAdapter={() => {}}
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('Use table')
    expect(markup).not.toContain('table must not render before the action')

    expect(withObjectViewAdapter).toBeFunction()
    expect(withObjectViewAdapter(viewConfig, 'table').presentation.adapter).toBe('table')
  })

  test('moves a draggable-only card between droppable columns with ArrowRight and ArrowLeft', () => {
    expect(OBJECT_KANBAN_KEYBOARD_SENSOR).toBe(KeyboardSensor)

    const rect = (left: number) => ({
      width: 100, height: 200, top: 0, left, right: left + 100, bottom: 200,
    })
    const droppables = [
      { id: 'object-kanban-column:option:0', disabled: false, node: { current: null }, rect: { current: rect(0) } },
      { id: 'object-kanban-column:option:1', disabled: false, node: { current: null }, rect: { current: rect(200) } },
      { id: 'object-kanban-column:no-group', disabled: false, node: { current: null }, rect: { current: rect(400) } },
    ]
    const context = {
      active: {
        id: 'object-kanban-entry:entry_a',
        data: { current: { objectKanbanColumnId: 'object-kanban-column:option:0' } },
      },
      collisionRect: rect(0),
      droppableContainers: {
        getEnabled: () => droppables.filter(candidate => !candidate.disabled),
        get: (id: string) => droppables.find(candidate => candidate.id === id),
        toArray: () => droppables,
      },
      droppableRects: new Map(droppables.map(candidate => [candidate.id, candidate.rect.current])),
      over: { id: 'object-kanban-column:option:0' },
      scrollableAncestors: [],
    } as unknown as Parameters<typeof OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER>[1]['context']
    let prevented = 0
    const event = (code: 'ArrowLeft' | 'ArrowRight') => ({
      code,
      preventDefault: () => { prevented += 1 },
    }) as KeyboardEvent

    expect(OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER(event('ArrowRight'), {
      active: 'object-kanban-entry:entry_a', currentCoordinates: { x: 0, y: 0 }, context,
    })).toEqual({ x: 200, y: 0 })
    context.over = {
      id: 'object-kanban-column:option:1',
      rect: rect(200),
      disabled: false,
      data: { current: undefined },
    }
    expect(OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER(event('ArrowLeft'), {
      active: 'object-kanban-entry:entry_a', currentCoordinates: { x: 200, y: 0 }, context,
    })).toEqual({ x: 0, y: 0 })
    droppables[2]!.disabled = true
    context.over = {
      id: 'object-kanban-column:no-group',
      rect: rect(400),
      disabled: true,
      data: { current: undefined },
    }
    expect(OBJECT_KANBAN_KEYBOARD_COORDINATE_GETTER(event('ArrowLeft'), {
      active: 'object-kanban-entry:entry_inconsistent', currentCoordinates: { x: 400, y: 0 }, context,
    })).toEqual({ x: 200, y: 0 })
    expect(prevented).toBe(3)

    const viewConfig = config('kanban')
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectViewHost
          payload={payload}
          config={viewConfig}
          query={evaluateWorkspaceObjectQuery(payload, viewConfig)}
          mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
          tableContent={null}
          onConfigureSetting={() => {}}
          onChangeAdapter={() => {}}
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('role="button"')
    expect(markup).toContain('tabindex="0"')
  })
})

describe('object Kanban commit lifecycle', () => {
  const entry = payload.entries[0]!

  test('keeps the optimistic move through commit and clears it only after canonical revalidation', async () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-1')
    expect(resolveObjectKanbanEntryValue(optimistic, entry, 'field_status')).toBe('Doing')

    const submittedValues: Array<Record<string, unknown>> = []
    const result = await commitObjectKanbanMove({
      objectId: payload.id,
      entry,
      fieldId: 'field_status',
      nextValue: 'Doing',
      operationId: 'operation-1',
      mutate: async action => {
        if (action.action !== 'upsert-entries') throw new Error('Unexpected action')
        if (action.entries[0]) submittedValues.push(action.entries[0].values)
        return { objectId: payload.id, revision: 5, projectionStatus: 'ready' }
      },
    })
    expect(submittedValues[0]).toEqual({ ...entry.values, field_status: 'Doing' })
    expect(result).toEqual({ status: 'awaiting-revalidation', entryId: entry.id, operationId: 'operation-1', revision: 5 })

    const awaiting = applyObjectKanbanCommit(optimistic, result)
    expect(resolveObjectKanbanEntryValue(awaiting, entry, 'field_status')).toBe('Doing')
    expect(reconcileObjectKanbanMoves(awaiting, payload)).toEqual(awaiting)

    const confirmedPayload = {
      ...payload,
      revision: 5,
      entries: payload.entries.map(candidate => candidate.id === entry.id
        ? { ...candidate, values: { ...candidate.values, field_status: 'Doing' } }
        : candidate),
    }
    const confirmed = reconcileObjectKanbanMoves(awaiting, confirmedPayload)
    expect(confirmed.pending).toEqual({})
    expect(resolveObjectKanbanEntryValue(confirmed, confirmedPayload.entries[0]!, 'field_status')).toBe('Doing')
  })

  test('rolls back rejected envelopes and projection-error responses', async () => {
    const cases: Array<{ response: WorkspaceObjectServiceResult; errorCode: ObjectKanbanErrorCode }> = [
      { response: { payload: null }, errorCode: 'commit-missing' },
      {
        response: { objectId: payload.id, revision: 5, projectionStatus: 'projection-error' },
        errorCode: 'projection-error',
      },
    ]
    for (const { response, errorCode } of cases) {
      const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-1')
      const result = await commitObjectKanbanMove({
        objectId: payload.id,
        entry,
        fieldId: 'field_status',
        nextValue: 'Doing',
        operationId: 'operation-1',
        mutate: async () => response,
      })
      const rolledBack = applyObjectKanbanCommit(optimistic, result)
      expect(result.status).toBe('rollback')
      if (result.status === 'rollback') expect(result.error.code).toBe(errorCode)
      expect(resolveObjectKanbanEntryValue(rolledBack, entry, 'field_status')).toBe('Todo')
      expect(rolledBack.errors[entry.id]?.code).toBe(errorCode)
    }
  })

  test('rolls back when the mutation transport throws', async () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-1')
    const result = await commitObjectKanbanMove({
      objectId: payload.id,
      entry,
      fieldId: 'field_status',
      nextValue: 'Doing',
      operationId: 'operation-1',
      mutate: async () => { throw new Error('transport offline') },
    })
    const rolledBack = applyObjectKanbanCommit(optimistic, result)
    expect(result).toEqual({
      status: 'rollback',
      entryId: entry.id,
      operationId: 'operation-1',
      error: { code: 'transport', detail: 'transport offline' },
    })
    expect(resolveObjectKanbanEntryValue(rolledBack, entry, 'field_status')).toBe('Todo')
  })

  test('preserves null and absent values in a translated no-group column with collision-safe ids', async () => {
    const ungroupedPayload: WorkspaceObjectPayload = {
      ...payload,
      entries: [
        ...payload.entries,
        { id: 'Todo', values: { field_name: 'Null', field_status: null } },
        { id: 'object-kanban-column:option:0', values: { field_name: 'Absent' } },
      ],
    }
    const viewConfig = config('kanban')
    const query = evaluateWorkspaceObjectQuery(ungroupedPayload, viewConfig)
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectViewHost
          payload={ungroupedPayload}
          config={viewConfig}
          query={query}
          mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
          tableContent={null}
          onConfigureSetting={() => {}}
          onChangeAdapter={() => {}}
        />
      </I18nextProvider>,
    )
    for (const candidate of query.entries) expect(markup).toContain(`data-entry-id="${candidate.id}"`)
    expect(markup).toContain('No group')
    expect(markup).toContain('data-object-kanban-column-id="object-kanban-column:no-group"')
    expect(markup).toContain('data-object-kanban-column-id="object-kanban-column:option:0"')

    expect(resolveObjectKanbanDropValue).toBeFunction()
    expect(resolveObjectKanbanDropValue(payload.fields[1]!, 'object-kanban-column:no-group')).toBeNull()
    expect(resolveObjectKanbanDropValue(payload.fields[1]!, 'object-kanban-column:option:0')).toBe('Todo')
    expect(resolveObjectKanbanDropValue(payload.fields[1]!, 'Todo')).toBeUndefined()

    const nullCommit = await commitObjectKanbanMove({
      objectId: payload.id,
      entry,
      fieldId: 'field_status',
      nextValue: null,
      operationId: 'operation-null',
      mutate: async action => {
        expect(action.action).toBe('upsert-entries')
        if (action.action === 'upsert-entries') expect(action.entries[0]?.values.field_status).toBeNull()
        return { objectId: payload.id, revision: 5, projectionStatus: 'ready' }
      },
    })
    expect(nullCommit.status).toBe('awaiting-revalidation')
  })

  test('ignores a second move for one pending entry and stale out-of-order responses', () => {
    const first = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-1')
    const ignoredSecond = beginObjectKanbanMove(first, entry, 'field_status', 'Todo', 'operation-2')
    expect(ignoredSecond).toBe(first)

    const laterState = {
      ...first,
      pending: {
        [entry.id]: {
          ...first.pending[entry.id]!,
          operationId: 'operation-2',
          nextValue: 'Todo',
        },
      },
    }
    const afterStale = applyObjectKanbanCommit(laterState, {
      status: 'rollback',
      entryId: entry.id,
      operationId: 'operation-1',
      error: { code: 'transport', detail: 'late response' },
    })
    expect(afterStale).toBe(laterState)
    expect(resolveObjectKanbanEntryValue(afterStale, entry, 'field_status')).toBe('Todo')
  })

  test('keeps moves for different entries independent', () => {
    const first = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-a')
    const secondEntry = payload.entries[1]!
    const both = beginObjectKanbanMove(first, secondEntry, 'field_status', 'Todo', 'operation-b')
    expect(Object.keys(both.pending)).toEqual([entry.id, secondEntry.id])
    const afterFirst = applyObjectKanbanCommit(both, {
      status: 'rollback',
      entryId: entry.id,
      operationId: 'operation-a',
      error: { code: 'commit-missing' },
    })
    expect(afterFirst.pending[secondEntry.id]?.operationId).toBe('operation-b')
    expect(resolveObjectKanbanEntryValue(afterFirst, secondEntry, 'field_status')).toBe('Todo')
  })

  test('uses localized error codes and keeps transport detail separate', () => {
    expect(ObjectKanbanErrorAlert).toBeFunction()
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectKanbanErrorAlert error={{ code: 'transport', detail: 'ECONNRESET' }} />
      </I18nextProvider>,
    )
    expect(markup).toContain('The Kanban move could not be saved.')
    expect(markup).toContain('ECONNRESET')
  })

  test('uses a localized canonical-mismatch code after revalidation', () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-1')
    const awaiting = applyObjectKanbanCommit(optimistic, {
      status: 'awaiting-revalidation', entryId: entry.id, operationId: 'operation-1', revision: 5,
    })
    const mismatch = reconcileObjectKanbanMoves(awaiting, { ...payload, revision: 5 })
    expect(mismatch.errors[entry.id]).toEqual({ code: 'canonical-mismatch' })
    expect(mismatch.pending).toEqual({})
  })

  test('settles immediately when the confirming payload arrived before the commit result', () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-early')
    const alreadyConfirmedPayload: WorkspaceObjectPayload = {
      ...payload,
      revision: 5,
      entries: payload.entries.map(candidate => candidate.id === entry.id
        ? { ...candidate, values: { ...candidate.values, field_status: 'Doing' } }
        : candidate),
    }
    const settled = applyObjectKanbanCommit(optimistic, {
      status: 'awaiting-revalidation', entryId: entry.id, operationId: 'operation-early', revision: 5,
    }, alreadyConfirmedPayload)
    expect(settled.pending).toEqual({})
    expect(settled.errors).toEqual({})
  })

  test('shows inconsistent required values in no-group but disables null drops', () => {
    const requiredPayload: WorkspaceObjectPayload = {
      ...payload,
      fields: payload.fields.map(field => field.id === 'field_status' ? { ...field, required: true } : field),
      entries: [
        ...payload.entries,
        { id: 'entry_inconsistent', values: { field_name: 'Inconsistent', field_status: null } },
      ],
    }
    const viewConfig = config('kanban')
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectViewHost
          payload={requiredPayload}
          config={viewConfig}
          query={evaluateWorkspaceObjectQuery(requiredPayload, viewConfig)}
          mutate={async () => ({ objectId: payload.id, revision: 5, projectionStatus: 'ready' })}
          tableContent={null}
          onConfigureSetting={() => {}}
          onChangeAdapter={() => {}}
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('data-entry-id="entry_inconsistent"')
    expect(markup).toContain('data-object-kanban-column-id="object-kanban-column:no-group"')
    expect(markup).toContain('data-object-kanban-column-disabled="true"')
    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-disabled="true"')
    expect(resolveObjectKanbanDropValue(requiredPayload.fields[1]!, 'object-kanban-column:no-group')).toBeUndefined()
  })

  test('isolates errors by entry across another entry success and retry', () => {
    const secondEntry = payload.entries[1]!
    const moveA = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing', 'operation-a')
    const failedA = applyObjectKanbanCommit(moveA, {
      status: 'rollback', entryId: entry.id, operationId: 'operation-a', error: { code: 'transport', detail: 'A failed' },
    })
    const moveB = beginObjectKanbanMove(failedA, secondEntry, 'field_status', 'Todo', 'operation-b')
    expect(moveB.errors).toEqual({ [entry.id]: { code: 'transport', detail: 'A failed' } })

    const committedB = applyObjectKanbanCommit(moveB, {
      status: 'awaiting-revalidation', entryId: secondEntry.id, operationId: 'operation-b', revision: 5,
    })
    expect(committedB.errors).toEqual({ [entry.id]: { code: 'transport', detail: 'A failed' } })

    const retryA = beginObjectKanbanMove(failedA, entry, 'field_status', 'Doing', 'operation-a-retry')
    expect(retryA.errors).toEqual({})

    expect(ObjectKanbanErrorAlerts).toBeFunction()
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ObjectKanbanErrorAlerts errors={{
          entry_a: { code: 'transport', detail: 'A failed' },
          entry_b: { code: 'canonical-mismatch' },
        }} />
      </I18nextProvider>,
    )
    expect(markup).toContain('data-object-kanban-error-entry="entry_a"')
    expect(markup).toContain('data-object-kanban-error-entry="entry_b"')
    expect(markup).toContain('The Kanban move could not be saved.')
    expect(markup).toContain('The Kanban move could not be confirmed after refresh.')
  })
})
