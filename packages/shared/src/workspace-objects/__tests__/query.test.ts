import { describe, expect, test } from 'bun:test';
import { evaluateWorkspaceObjectQuery } from '../query.ts';
import { WorkspaceObjectSavedViewSchema, type WorkspaceObjectViewConfig } from '../view-schema.ts';
import type { WorkspaceObjectPayload } from '../types.ts';

const payload: WorkspaceObjectPayload = {
  id: 'object_deals',
  slug: 'deals',
  name: 'Deals',
  revision: 4,
  projectionStatus: 'ready',
  fields: [
    { id: 'field_name', name: 'Name', type: 'text' },
    { id: 'field_amount', name: 'Amount', type: 'number' },
    { id: 'field_active', name: 'Active', type: 'boolean' },
    { id: 'field_status', name: 'Status', type: 'status', options: ['Lead', 'Won'] },
    { id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' },
  ],
  entries: [
    { id: 'entry_c', values: { field_name: 'Gamma', field_amount: 30, field_active: true, field_status: 'Won', field_company: 'company_2' } },
    { id: 'entry_a', values: { field_name: 'Alpha', field_amount: 10, field_active: true, field_status: 'Lead', field_company: 'company_1' } },
    { id: 'entry_b', values: { field_name: 'Beta', field_amount: 30, field_active: true, field_status: 'Lead', field_company: 'company_2' } },
    { id: 'entry_d', values: { field_name: 'Delta', field_amount: 30, field_active: false, field_status: 'Lead', field_company: 'company_1' } },
  ],
  savedViews: [],
};

function view(overrides: Partial<WorkspaceObjectViewConfig> = {}): WorkspaceObjectViewConfig {
  return {
    schemaVersion: 1,
    search: '',
    filter: null,
    sort: [],
    columnVisibility: {},
    presentation: { adapter: 'table', settings: {} },
    ...overrides,
  };
}

describe('WorkspaceObjectSavedViewSchema', () => {
  test('accepts a strict versioned view with nested boolean filters and adapter settings', () => {
    const saved = WorkspaceObjectSavedViewSchema.parse({
      id: 'view_qualified',
      name: 'Qualified',
      config: view({
        search: 'acme',
        filter: {
          type: 'group',
          conjunction: 'and',
          clauses: [
            { type: 'rule', fieldId: 'field_amount', operator: 'gte', value: 10 },
            {
              type: 'group',
              conjunction: 'or',
              clauses: [
                { type: 'rule', fieldId: 'field_status', operator: 'equals', value: 'Lead' },
                { type: 'rule', fieldId: 'field_status', operator: 'equals', value: 'Won' },
              ],
            },
          ],
        },
        sort: [{ fieldId: 'field_amount', direction: 'desc' }],
        columnVisibility: { field_active: false },
        presentation: { adapter: 'table', settings: { density: 'compact', pageSize: 50 } },
      }),
    });

    expect(saved.config.schemaVersion).toBe(1);
    expect(saved.config.filter).toMatchObject({ type: 'group', conjunction: 'and' });
    expect(saved.config.presentation.settings).toEqual({ density: 'compact', pageSize: 50 });
  });

  test('rejects unknown keys, unsupported versions and excessively deep filters', () => {
    expect(WorkspaceObjectSavedViewSchema.safeParse({
      id: 'view_loose', name: 'Loose', config: { ...view(), columns: ['field_name'] },
    }).success).toBe(false);
    expect(WorkspaceObjectSavedViewSchema.safeParse({
      id: 'view_future', name: 'Future', config: { ...view(), schemaVersion: 2 },
    }).success).toBe(false);

    let filter: unknown = { type: 'rule', fieldId: 'field_name', operator: 'equals', value: 'Alpha' };
    for (let depth = 0; depth < 10; depth += 1) {
      filter = { type: 'group', conjunction: 'and', clauses: [filter] };
    }
    expect(WorkspaceObjectSavedViewSchema.safeParse({
      id: 'view_deep', name: 'Deep', config: { ...view(), filter },
    }).success).toBe(false);
  });
});

describe('evaluateWorkspaceObjectQuery', () => {
  test('evaluates nested filters, search and a stable multi-sort deterministically', () => {
    const result = evaluateWorkspaceObjectQuery(payload, view({
      search: 'a',
      filter: {
        type: 'group',
        conjunction: 'and',
        clauses: [
          { type: 'rule', fieldId: 'field_active', operator: 'equals', value: true },
          {
            type: 'group',
            conjunction: 'or',
            clauses: [
              { type: 'rule', fieldId: 'field_status', operator: 'equals', value: 'Lead' },
              { type: 'rule', fieldId: 'field_amount', operator: 'gte', value: 30 },
            ],
          },
        ],
      },
      sort: [
        { fieldId: 'field_amount', direction: 'desc' },
        { fieldId: 'field_status', direction: 'asc' },
      ],
    }));

    expect(result.entries.map(entry => entry.id)).toEqual(['entry_b', 'entry_c', 'entry_a']);
  });

  test('keeps source order when all configured sort keys compare equal', () => {
    const result = evaluateWorkspaceObjectQuery(payload, view({
      filter: { type: 'rule', fieldId: 'field_amount', operator: 'equals', value: 30 },
      sort: [{ fieldId: 'field_amount', direction: 'desc' }],
    }));

    expect(result.entries.map(entry => entry.id)).toEqual(['entry_c', 'entry_b', 'entry_d']);
  });

  test('returns only visible columns without deleting hidden values from entries', () => {
    const result = evaluateWorkspaceObjectQuery(payload, view({
      columnVisibility: { field_amount: false, field_active: false },
    }));

    expect(result.fields.map(field => field.id)).toEqual(['field_name', 'field_status', 'field_company']);
    expect(result.entries[0]?.values.field_amount).toBe(30);
  });

  test('resolves current relation labels for rendering, filtering and sorting while retaining stable ids', () => {
    const config = view({
      filter: { type: 'rule', fieldId: 'field_company', operator: 'contains', value: 'zenith' },
      sort: [{ fieldId: 'field_company', direction: 'asc' }],
    });
    const first = evaluateWorkspaceObjectQuery(payload, config, {
      relationLabels: new Map([['company_1', 'Acme'], ['company_2', 'Zenith']]),
    });
    const renamed = evaluateWorkspaceObjectQuery(payload, { ...config, filter: null }, {
      relationLabels: new Map([['company_1', 'Zeta'], ['company_2', 'Aardvark']]),
    });

    expect(first.entries.map(entry => entry.id)).toEqual(['entry_c', 'entry_b']);
    expect(first.displayValues.get('entry_c')?.field_company).toBe('Zenith');
    expect(first.entries[0]?.values.field_company).toBe('company_2');
    expect(renamed.entries.map(entry => entry.id)).toEqual(['entry_c', 'entry_b', 'entry_a', 'entry_d']);
    expect(renamed.entries[0]?.values.field_company).toBe('company_2');
  });
});
