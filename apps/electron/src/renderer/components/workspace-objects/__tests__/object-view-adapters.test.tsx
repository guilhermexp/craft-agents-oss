import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { evaluateWorkspaceObjectQuery } from '@craft-agent/shared/workspace-objects/query'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import type { WorkspaceObjectViewConfig } from '@craft-agent/shared/workspace-objects/view-schema'
import {
  EMPTY_OBJECT_KANBAN_MOVE_STATE,
  OBJECT_VIEW_ADAPTERS,
  ObjectViewHost,
  applyObjectKanbanCommit,
  beginObjectKanbanMove,
  commitObjectKanbanMove,
  getObjectViewAdapter,
  reconcileObjectKanbanMoves,
  resolveObjectKanbanEntryValue,
  resolveObjectViewConfiguration,
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
        'chat.workspaceObjectKanbanCommitMissing': 'The Kanban move did not return a canonical commit.',
        'chat.workspaceObjectKanbanProjectionError': 'The Kanban move committed but its projection requires repair.',
        'chat.workspaceObjectKanbanNotConfirmed': 'The Kanban move could not be confirmed after refresh.',
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
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('data-object-view-empty="kanban"')
    expect(markup).toContain('Configure view')
    expect(markup).not.toContain('table must not render')
  })
})

describe('object Kanban commit lifecycle', () => {
  const entry = payload.entries[0]!

  test('keeps the optimistic move through commit and clears it only after canonical revalidation', async () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing')
    expect(resolveObjectKanbanEntryValue(optimistic, entry, 'field_status')).toBe('Doing')

    const submittedValues: Array<Record<string, unknown>> = []
    const result = await commitObjectKanbanMove({
      objectId: payload.id,
      entry,
      fieldId: 'field_status',
      nextValue: 'Doing',
      mutate: async action => {
        if (action.action !== 'upsert-entries') throw new Error('Unexpected action')
        if (action.entries[0]) submittedValues.push(action.entries[0].values)
        return { objectId: payload.id, revision: 5, projectionStatus: 'ready' }
      },
    })
    expect(submittedValues[0]).toEqual({ ...entry.values, field_status: 'Doing' })
    expect(result).toEqual({ status: 'awaiting-revalidation', entryId: entry.id, revision: 5 })

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
    for (const response of [
      { payload: null },
      { objectId: payload.id, revision: 5, projectionStatus: 'projection-error' as const },
    ]) {
      const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing')
      const result = await commitObjectKanbanMove({
        objectId: payload.id,
        entry,
        fieldId: 'field_status',
        nextValue: 'Doing',
        mutate: async () => response,
      })
      const rolledBack = applyObjectKanbanCommit(optimistic, result)
      expect(result.status).toBe('rollback')
      expect(resolveObjectKanbanEntryValue(rolledBack, entry, 'field_status')).toBe('Todo')
      expect(rolledBack.error).not.toBeNull()
    }
  })

  test('rolls back when the mutation transport throws', async () => {
    const optimistic = beginObjectKanbanMove(EMPTY_OBJECT_KANBAN_MOVE_STATE, entry, 'field_status', 'Doing')
    const result = await commitObjectKanbanMove({
      objectId: payload.id,
      entry,
      fieldId: 'field_status',
      nextValue: 'Doing',
      mutate: async () => { throw new Error('transport offline') },
    })
    const rolledBack = applyObjectKanbanCommit(optimistic, result)
    expect(result).toEqual({ status: 'rollback', entryId: entry.id, error: 'transport offline' })
    expect(resolveObjectKanbanEntryValue(rolledBack, entry, 'field_status')).toBe('Todo')
  })
})
