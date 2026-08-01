import type {
  WorkspaceObjectEntry,
  WorkspaceObjectField,
  WorkspaceObjectPayload,
  WorkspaceObjectValue,
} from './types.ts';
import {
  WorkspaceObjectViewConfigSchema,
  type WorkspaceObjectFilterClause,
  type WorkspaceObjectFilterRule,
  type WorkspaceObjectFilterScalar,
  type WorkspaceObjectViewConfig,
} from './view-schema.ts';

export interface WorkspaceObjectQueryContext {
  relationLabels?: ReadonlyMap<string, string>;
}

export interface WorkspaceObjectQueryResult {
  fields: WorkspaceObjectField[];
  entries: WorkspaceObjectEntry[];
  displayValues: Map<string, Record<string, WorkspaceObjectValue>>;
}

export function getWorkspaceObjectEntryLabel(payload: WorkspaceObjectPayload, entry: WorkspaceObjectEntry): string {
  const labelField = payload.fields.find(field => field.type === 'text') ?? payload.fields[0];
  const value = labelField ? entry.values[labelField.id] : undefined;
  return value === null || value === undefined || value === '' ? entry.id : String(value);
}

export function buildWorkspaceObjectRelationLabels(payloads: readonly WorkspaceObjectPayload[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const payload of payloads) {
    for (const entry of payload.entries) labels.set(entry.id, getWorkspaceObjectEntryLabel(payload, entry));
  }
  return labels;
}

function relationDisplayValue(value: WorkspaceObjectValue, context: WorkspaceObjectQueryContext): WorkspaceObjectValue {
  return typeof value === 'string' ? context.relationLabels?.get(value) ?? value : value;
}

function displayValue(field: WorkspaceObjectField, value: WorkspaceObjectValue | undefined, context: WorkspaceObjectQueryContext): WorkspaceObjectValue {
  if (value === undefined) return null;
  return field.type === 'relation' ? relationDisplayValue(value, context) : value;
}

function normalizeString(value: WorkspaceObjectValue): string {
  return value === null ? '' : String(value).trim().toLocaleLowerCase('en-US');
}

function deterministicCompare(left: WorkspaceObjectValue, right: WorkspaceObjectValue): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === false ? -1 : 1;
  const leftText = normalizeString(left);
  const rightText = normalizeString(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function compareFieldValues(
  field: WorkspaceObjectField,
  left: WorkspaceObjectValue,
  right: WorkspaceObjectValue,
): number {
  if ((field.type === 'date' || field.type === 'datetime') && typeof left === 'string' && typeof right === 'string') {
    const leftInstant = Date.parse(left)
    const rightInstant = Date.parse(right)
    if (!Number.isNaN(leftInstant) && !Number.isNaN(rightInstant)) return leftInstant === rightInstant ? 0 : leftInstant < rightInstant ? -1 : 1
  }
  return deterministicCompare(left, right)
}

function equals(left: WorkspaceObjectValue, right: WorkspaceObjectFilterScalar): boolean {
  if (typeof left === 'string' && typeof right === 'string') return normalizeString(left) === normalizeString(right);
  return left === right;
}

function matchesRule(field: WorkspaceObjectField, value: WorkspaceObjectValue, rule: WorkspaceObjectFilterRule): boolean {
  const empty = value === null || (typeof value === 'string' && value.trim() === '');
  if (rule.operator === 'is-empty') return empty;
  if (rule.operator === 'is-not-empty') return !empty;
  const expected = rule.value;
  if (expected === undefined) return false;
  if (rule.operator === 'in' || rule.operator === 'not-in') {
    const matches = Array.isArray(expected) && expected.some(candidate => equals(value, candidate));
    return rule.operator === 'in' ? matches : !matches;
  }
  if (Array.isArray(expected)) return false;
  if (rule.operator === 'equals') return equals(value, expected);
  if (rule.operator === 'not-equals') return !equals(value, expected);
  if (rule.operator === 'contains' || rule.operator === 'not-contains') {
    const matches = normalizeString(value).includes(normalizeString(expected));
    return rule.operator === 'contains' ? matches : !matches;
  }
  const comparison = compareFieldValues(field, value, expected);
  if (rule.operator === 'gt' || rule.operator === 'after') return comparison > 0;
  if (rule.operator === 'gte') return comparison >= 0;
  if (rule.operator === 'lt' || rule.operator === 'before') return comparison < 0;
  return comparison <= 0;
}

function matchesFilter(
  clause: WorkspaceObjectFilterClause,
  entry: WorkspaceObjectEntry,
  fieldById: ReadonlyMap<string, WorkspaceObjectField>,
  context: WorkspaceObjectQueryContext,
): boolean {
  if (clause.type === 'group') {
    return clause.conjunction === 'and'
      ? clause.clauses.every(child => matchesFilter(child, entry, fieldById, context))
      : clause.clauses.some(child => matchesFilter(child, entry, fieldById, context));
  }
  const field = fieldById.get(clause.fieldId);
  if (!field) return false;
  return matchesRule(field, displayValue(field, entry.values[field.id], context), clause);
}

export function evaluateWorkspaceObjectQuery(
  payload: WorkspaceObjectPayload,
  input: WorkspaceObjectViewConfig,
  context: WorkspaceObjectQueryContext = {},
): WorkspaceObjectQueryResult {
  const config = WorkspaceObjectViewConfigSchema.parse(input);
  const fieldById = new Map(payload.fields.map(field => [field.id, field]));
  const displayValues = new Map<string, Record<string, WorkspaceObjectValue>>();
  for (const entry of payload.entries) {
    displayValues.set(entry.id, Object.fromEntries(payload.fields.map(field => [
      field.id,
      displayValue(field, entry.values[field.id], context),
    ])));
  }

  const search = config.search.trim().toLocaleLowerCase('en-US');
  const indexed: Array<{ entry: WorkspaceObjectEntry; index: number }> = [];
  for (const [index, entry] of payload.entries.entries()) {
    if (config.filter && !matchesFilter(config.filter, entry, fieldById, context)) continue;
    if (search) {
      const values = displayValues.get(entry.id) ?? {};
      if (!payload.fields.some(field => normalizeString(values[field.id] ?? null).includes(search))) continue;
    }
    indexed.push({ entry, index });
  }

  indexed.sort((left, right) => {
    for (const sort of config.sort) {
      const field = fieldById.get(sort.fieldId);
      if (!field) continue;
      const leftValue = displayValues.get(left.entry.id)?.[field.id] ?? null;
      const rightValue = displayValues.get(right.entry.id)?.[field.id] ?? null;
      const comparison = compareFieldValues(field, leftValue, rightValue);
      if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison;
    }
    return left.index - right.index;
  });

  return {
    fields: payload.fields.filter(field => config.columnVisibility[field.id] !== false),
    entries: indexed.map(item => item.entry),
    displayValues,
  };
}
