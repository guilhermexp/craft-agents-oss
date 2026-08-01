import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { WorkspaceObjectField, WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import {
  parseObjectFieldDraft,
  resolveObjectFieldDisplayValue,
  submitObjectFieldEdit,
  reconcileObjectFieldEdit,
  type ObjectFieldEditState,
} from '../ObjectFieldEditor'
import { ObjectTableView, createSavedTableView, resolveTablePresentation, restoreSavedTableView } from '../ObjectTableView'

const fields = {
  text: { id: 'field_text', name: 'Text', type: 'text' },
  number: { id: 'field_number', name: 'Number', type: 'number' },
  boolean: { id: 'field_boolean', name: 'Boolean', type: 'boolean' },
  date: { id: 'field_date', name: 'Date', type: 'date' },
  datetime: { id: 'field_datetime', name: 'Datetime', type: 'datetime' },
  select: { id: 'field_select', name: 'Select', type: 'select', options: ['One', 'Two'] },
  status: { id: 'field_status', name: 'Status', type: 'status', options: ['Open', 'Done'] },
  relation: { id: 'field_relation', name: 'Relation', type: 'relation', relationObjectId: 'object_companies' },
  file: { id: 'field_file', name: 'File', type: 'file' },
} satisfies Record<string, WorkspaceObjectField>

function editing(draft: string): ObjectFieldEditState {
  return { status: 'editing', draft, error: null }
}

describe('typed object field parsing', () => {
  test('parses valid values for every current field type', () => {
    expect(parseObjectFieldDraft(fields.text, 'Ada')).toEqual({ success: true, value: 'Ada' })
    expect(parseObjectFieldDraft(fields.number, '42.5')).toEqual({ success: true, value: 42.5 })
    expect(parseObjectFieldDraft(fields.boolean, 'true')).toEqual({ success: true, value: true })
    expect(parseObjectFieldDraft(fields.date, '2026-08-01')).toEqual({ success: true, value: '2026-08-01' })
    expect(parseObjectFieldDraft(fields.datetime, '2026-08-01T15:30:00.000Z')).toEqual({ success: true, value: '2026-08-01T15:30:00.000Z' })
    expect(parseObjectFieldDraft(fields.select, 'Two')).toEqual({ success: true, value: 'Two' })
    expect(parseObjectFieldDraft(fields.status, 'Done')).toEqual({ success: true, value: 'Done' })
    expect(parseObjectFieldDraft(fields.relation, 'entry_acme', new Set(['entry_acme']))).toEqual({ success: true, value: 'entry_acme' })
    expect(parseObjectFieldDraft(fields.file, 'docs/ada.md')).toEqual({ success: true, value: 'docs/ada.md' })
  })

  test('returns actionable errors for invalid scalar, temporal, option and relation families', () => {
    expect(parseObjectFieldDraft(fields.number, 'forty').success).toBe(false)
    expect(parseObjectFieldDraft(fields.boolean, 'yes').success).toBe(false)
    expect(parseObjectFieldDraft(fields.date, '2026-02-31').success).toBe(false)
    expect(parseObjectFieldDraft(fields.datetime, '2026-08-01 12:00').success).toBe(false)
    expect(parseObjectFieldDraft(fields.select, 'Three').success).toBe(false)
    expect(parseObjectFieldDraft(fields.status, 'Missing').success).toBe(false)
    expect(parseObjectFieldDraft(fields.relation, 'entry_missing', new Set(['entry_acme'])).success).toBe(false)
    expect(parseObjectFieldDraft(fields.file, '\0bad').success).toBe(false)
  })
})

describe('object field commit state', () => {
  test('invalid input keeps editing open and does not call the mutation transport', async () => {
    const mutate = mock(async () => ({ objectId: 'object_people', revision: 3, projectionStatus: 'ready' as const }))
    const result = await submitObjectFieldEdit({
      state: editing('NaN'), field: fields.number, objectId: 'object_people', entryId: 'entry_ada',
      currentValues: { field_text: 'Ada' }, mutate,
    })

    expect(result).toMatchObject({ status: 'editing', draft: 'NaN', error: expect.stringContaining('number') })
    expect(mutate).not.toHaveBeenCalled()
  })

  test('waits for the committed revision to revalidate before closing the editor', async () => {
    const mutate = mock(async () => ({ objectId: 'object_people', revision: 7, projectionStatus: 'ready' as const }))
    const pending = await submitObjectFieldEdit({
      state: editing('42'), field: fields.number, objectId: 'object_people', entryId: 'entry_ada',
      currentValues: { field_text: 'Ada', field_number: 1 }, mutate,
    })

    expect(mutate).toHaveBeenCalledWith({
      action: 'upsert-entries', objectId: 'object_people',
      entries: [{ id: 'entry_ada', values: { field_text: 'Ada', field_number: 42 } }],
    })
    expect(pending).toMatchObject({ status: 'awaiting-revalidation', revision: 7, value: 42 })
    expect(reconcileObjectFieldEdit(pending, 6, 1)).toEqual(pending)
    expect(reconcileObjectFieldEdit(pending, 7, 42)).toEqual({ status: 'idle' })
  })

  test('keeps the editor open for a rejected mutation response and a thrown transport error', async () => {
    const rejected = await submitObjectFieldEdit({
      state: editing('Ada'), field: fields.text, objectId: 'object_people', entryId: 'entry_ada', currentValues: {},
      mutate: async () => ({ payload: null }),
    })
    const thrown = await submitObjectFieldEdit({
      state: editing('Ada'), field: fields.text, objectId: 'object_people', entryId: 'entry_ada', currentValues: {},
      mutate: async () => { throw new Error('transport offline') },
    })

    expect(rejected).toMatchObject({ status: 'editing', error: expect.stringContaining('commit') })
    expect(thrown).toMatchObject({ status: 'editing', error: expect.stringContaining('transport offline') })
  })

  test('renders a renamed relation label without replacing its stable id', () => {
    expect(resolveObjectFieldDisplayValue(fields.relation, 'entry_acme', new Map([['entry_acme', 'Acme']]))).toBe('Acme')
    expect(resolveObjectFieldDisplayValue(fields.relation, 'entry_acme', new Map([['entry_acme', 'Acme Renamed']]))).toBe('Acme Renamed')
    expect(parseObjectFieldDraft(fields.relation, 'entry_acme', new Set(['entry_acme']))).toEqual({ success: true, value: 'entry_acme' })
  })
})

describe('saved table view state', () => {
  test('round-trips filter, search, multi-sort, hidden columns and presentation settings', () => {
    const saved = createSavedTableView('view_active', 'Active', {
      schemaVersion: 1,
      search: 'ada',
      filter: {
        type: 'group', conjunction: 'and', clauses: [
          { type: 'rule', fieldId: 'field_boolean', operator: 'equals', value: true },
          { type: 'rule', fieldId: 'field_number', operator: 'gte', value: 10 },
        ],
      },
      sort: [
        { fieldId: 'field_status', direction: 'asc' },
        { fieldId: 'field_number', direction: 'desc' },
      ],
      columnVisibility: { field_file: false },
      presentation: { adapter: 'table', settings: { density: 'compact', pageSize: 25 } },
    })

    expect(restoreSavedTableView(saved)).toEqual(saved.config)
    expect(resolveTablePresentation(saved.config)).toEqual({ density: 'compact', pageSize: 25 })
    expect(resolveTablePresentation({ ...saved.config, presentation: { adapter: 'table', settings: { pageSize: 0 } } }))
      .toEqual({ density: 'comfortable', pageSize: 50 })
  })

  test('restores the target saved view when the existing Phase A tab carries its view id', async () => {
    const config = {
      schemaVersion: 1 as const,
      search: 'beta',
      filter: null,
      sort: [],
      columnVisibility: { field_secret: false },
      presentation: { adapter: 'table' as const, settings: {} },
    }
    const payload: WorkspaceObjectPayload = {
      id: 'object_people', slug: 'people', name: 'People', revision: 3, projectionStatus: 'ready',
      fields: [fields.text, { id: 'field_secret', name: 'Secret', type: 'text' }],
      entries: [
        { id: 'entry_alpha', values: { field_text: 'Alpha', field_secret: 'Alpha Secret' } },
        { id: 'entry_beta', values: { field_text: 'Beta', field_secret: 'Beta Secret' } },
      ],
      savedViews: [createSavedTableView('view_beta', 'Beta only', config)],
    }
    const i18n = createInstance()
    await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })
    const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(ObjectTableView, {
        payload,
        relationPayloads: [],
        mutate: async () => ({ objectId: payload.id, revision: 4, projectionStatus: 'ready' as const }),
        initialViewId: 'view_beta',
      })))

    expect(html).toContain('Beta')
    expect(html).not.toContain('Alpha Secret')
    expect(html).not.toContain('Beta Secret')
    expect(html).not.toContain('>Alpha<')
  })
})

const _payloadCompileGuard: WorkspaceObjectPayload | null = null
void _payloadCompileGuard
