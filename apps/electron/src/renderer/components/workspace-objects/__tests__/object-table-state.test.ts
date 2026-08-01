import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { WorkspaceObjectField, WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import { DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW } from '@craft-agent/shared/workspace-objects/view-schema'
import {
  parseObjectFieldDraft,
  resolveObjectFieldDisplayValue,
  submitObjectFieldEdit,
  reconcileObjectFieldEdit,
  type ObjectFieldEditState,
} from '../ObjectFieldEditor'
import {
  ObjectTableView,
  applyRelationOptionLoadResult,
  appendRelationOptionPage,
  canonicalSavedViewFingerprint,
  createSavedTableView,
  reconcileRelationOptionPages,
  requestRelationOptionPage,
  resolveSavedTableViewState,
  resolveTablePresentation,
  restoreSavedTableView,
  shouldPersistSavedViewTarget,
} from '../ObjectTableView'

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
    expect(parseObjectFieldDraft(fields.text, 'x'.repeat(64_001)).success).toBe(false)
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

  test('resolves the latest canonical saved-view config after an external update', () => {
    const first = createSavedTableView('view_live', 'Live', { ...DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW, search: 'before' })
    const latest = createSavedTableView('view_live', 'Live renamed', {
      ...DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW,
      search: 'after',
      presentation: { adapter: 'table', settings: { nested: { lane: ['a', { color: 'blue' }] } } },
    })
    const base = { id: 'object_people', slug: 'people', name: 'People', projectionStatus: 'ready' as const, fields: [], entries: [] }

    expect(resolveSavedTableViewState({ ...base, revision: 1, savedViews: [first] }, 'view_live')).toMatchObject({
      activeViewId: 'view_live', viewName: 'Live', config: { search: 'before' },
    })
    expect(resolveSavedTableViewState({ ...base, revision: 2, savedViews: [latest] }, 'view_live')).toMatchObject({
      activeViewId: 'view_live', viewName: 'Live renamed', config: { search: 'after' },
    })
    expect(shouldPersistSavedViewTarget({ ...base, revision: 2, savedViews: [latest] }, 'view_live', undefined)).toBe(true)
    expect(shouldPersistSavedViewTarget({ ...base, revision: 1, savedViews: [first] }, 'view_missing', undefined)).toBe(false)
  })

  test('keeps unsaved local view state across unrelated entry revision bumps', () => {
    const saved = createSavedTableView('view_live', 'Live', { ...DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW, search: 'canonical' })
    const base: WorkspaceObjectPayload = {
      id: 'object_people', slug: 'people', name: 'People', revision: 1, projectionStatus: 'ready',
      fields: [fields.text], entries: [{ id: 'entry_ada', values: { field_text: 'Ada' } }], savedViews: [saved],
    }
    const unrelatedEntryRevision = {
      ...base,
      revision: 2,
      entries: [{ id: 'entry_ada', values: { field_text: 'Ada updated' } }],
    }
    const changedSavedView = {
      ...unrelatedEntryRevision,
      revision: 3,
      savedViews: [createSavedTableView('view_live', 'Live', { ...saved.config, search: 'canonical changed' })],
    }

    expect(canonicalSavedViewFingerprint(base, 'view_live')).toBe(canonicalSavedViewFingerprint(unrelatedEntryRevision, 'view_live'))
    expect(canonicalSavedViewFingerprint(changedSavedView, 'view_live')).not.toBe(canonicalSavedViewFingerprint(base, 'view_live'))
  })

  test('preserves accumulated relation cursor on same revision and resets on canonical change', () => {
    const initial = {
      options: [{ id: 'entry_001', label: 'One' }, { id: 'entry_002', label: 'Two' }],
      nextCursor: 'entry_002',
      revision: 4,
    }
    const accumulated = appendRelationOptionPage(initial, {
      options: [{ id: 'entry_003', label: 'Three' }],
      nextCursor: 'entry_003',
      revision: 4,
    })
    if (!accumulated) throw new Error('Expected a same-revision relation page')
    const sameRevision = reconcileRelationOptionPages({ object_companies: accumulated }, { object_companies: initial })

    expect(sameRevision.object_companies).toEqual({
      options: [
        { id: 'entry_001', label: 'One' },
        { id: 'entry_002', label: 'Two' },
        { id: 'entry_003', label: 'Three' },
      ],
      nextCursor: 'entry_003',
      revision: 4,
    })

    expect(reconcileRelationOptionPages(sameRevision, {
      object_companies: {
        options: [{ id: 'entry_001', label: 'One renamed' }],
        nextCursor: 'entry_001',
        revision: 5,
      },
    }).object_companies).toEqual({
      options: [{ id: 'entry_001', label: 'One renamed' }],
      nextCursor: 'entry_001',
      revision: 5,
    })
  })

  test('keeps the newer canonical relation snapshot coherent on a concurrent load-more mismatch', () => {
    const canonical = {
      options: [{ id: 'entry_new', label: 'New snapshot' }],
      nextCursor: 'entry_new',
      revision: 5,
    }
    const staleLoadMore = {
      options: [{ id: 'entry_stale', label: 'Stale page' }],
      nextCursor: null,
      revision: 4,
    }

    expect(() => appendRelationOptionPage(canonical, staleLoadMore)).not.toThrow()
    expect(appendRelationOptionPage(canonical, staleLoadMore)).toBeNull()
    expect(applyRelationOptionLoadResult(
      { pages: { object_companies: canonical }, error: null },
      'object_companies',
      { status: 'success', page: staleLoadMore },
    )).toEqual({
      pages: { object_companies: canonical },
      error: { relationObjectId: 'object_companies', message: 'Relation options changed while loading more' },
    })
  })

  test('turns relation transport rejection into a recoverable result', async () => {
    const request = {
      action: 'list-relation-options' as const,
      objectId: 'object_companies',
      after: 'entry_200',
      limit: 200,
    }
    await expect(requestRelationOptionPage(request, async () => {
      throw new Error('transport offline')
    })).resolves.toEqual({ status: 'error', message: 'transport offline' })
  })

  test('recovers every currently referenced relation id in bounded coherent batches', async () => {
    const referencedIds = Array.from({ length: 401 }, (_, index) => `entry_${String(index).padStart(3, '0')}`)
    const requests: Array<{ includeEntryIds?: string[] }> = []
    const result = await requestRelationOptionPage({
      action: 'list-relation-options', objectId: 'object_companies', limit: 200,
    }, async request => {
      if (request.action !== 'list-relation-options') throw new Error('Unexpected workspace object action')
      requests.push(request)
      return {
        relationOptions: request.includeEntryIds
          ? request.includeEntryIds.map(id => ({ id, label: `Label ${id}` }))
          : [{ id: 'first_page', label: 'First page' }],
        nextCursor: request.includeEntryIds ? null : 'first_page',
        revision: 8,
      }
    }, referencedIds)

    expect(requests.map(request => request.includeEntryIds?.length ?? 0)).toEqual([0, 200, 200, 1])
    expect(result).toMatchObject({
      status: 'success',
      page: { revision: 8, nextCursor: 'first_page' },
    })
    if (result.status !== 'success') throw new Error('Expected relation recovery to succeed')
    expect(result.page.options).toContainEqual({ id: 'entry_400', label: 'Label entry_400' })
  })

  test('replaces a mismatched snapshot only after coherent recovery keeps a relation beyond page 200 valid', async () => {
    let requestIndex = 0
    const mismatch = await requestRelationOptionPage({
      action: 'list-relation-options', objectId: 'object_companies', limit: 200,
    }, async request => {
      if (request.action !== 'list-relation-options') throw new Error('Unexpected workspace object action')
      return {
        relationOptions: request.includeEntryIds?.map(id => ({ id, label: `Label ${id}` })) ?? [],
        nextCursor: null,
        revision: requestIndex++ === 0 ? 8 : 9,
      }
    }, ['entry_400'])
    expect(mismatch).toEqual({ status: 'error', message: 'Relation options changed during lookup: object_companies' })

    const recoveredPage = {
      options: [
        { id: 'first_page', label: 'First page' },
        { id: 'entry_400', label: 'Recovered label' },
      ],
      nextCursor: 'first_page',
      revision: 9,
    }
    const recovered = applyRelationOptionLoadResult({
      pages: {
        object_companies: {
          options: [{ id: 'stale', label: 'Stale' }],
          nextCursor: 'stale',
          revision: 8,
        },
      },
      error: { relationObjectId: 'object_companies', message: 'changed' },
    }, 'object_companies', { status: 'success', page: recoveredPage }, 'replace')

    expect(recovered).toEqual({ pages: { object_companies: recoveredPage }, error: null })
    const validRelationIds = new Set(recovered.pages.object_companies?.options.map(option => option.id))
    expect(parseObjectFieldDraft(fields.relation, 'entry_400', validRelationIds)).toEqual({ success: true, value: 'entry_400' })
  })

  test('discards a stale retry response after refresh installs a newer relation snapshot', () => {
    const revision9 = {
      options: [{ id: 'entry_current', label: 'Current label' }],
      nextCursor: 'current_cursor',
      revision: 9,
    }
    const state = {
      pages: { object_companies: revision9 },
      error: null,
    }

    expect(applyRelationOptionLoadResult(state, 'object_companies', {
      status: 'success',
      page: {
        options: [{ id: 'entry_stale', label: 'Stale label' }],
        nextCursor: 'stale_cursor',
        revision: 8,
      },
    }, 'replace')).toEqual({
      pages: { object_companies: revision9 },
      error: { relationObjectId: 'object_companies', message: 'A newer relation snapshot is already loaded' },
    })

    const equalRevision = {
      options: [{ id: 'entry_equal', label: 'Equal revision refresh' }],
      nextCursor: 'equal_cursor',
      revision: 9,
    }
    expect(applyRelationOptionLoadResult(state, 'object_companies', {
      status: 'success', page: equalRevision,
    }, 'replace')).toEqual({ pages: { object_companies: equalRevision }, error: null })

    const revision10 = {
      options: [{ id: 'entry_newer', label: 'Newer label' }],
      nextCursor: 'newer_cursor',
      revision: 10,
    }
    expect(applyRelationOptionLoadResult(state, 'object_companies', {
      status: 'success', page: revision10,
    }, 'replace')).toEqual({ pages: { object_companies: revision10 }, error: null })
  })
})

const _payloadCompileGuard: WorkspaceObjectPayload | null = null
void _payloadCompileGuard
