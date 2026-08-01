import { z } from 'zod';

const IdentifierSchema = z.string().min(1).max(120);
const FilterScalarSchema = z.union([
  z.string().max(64_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type WorkspaceObjectFilterScalar = z.infer<typeof FilterScalarSchema>;
export type WorkspaceObjectFilterValue = WorkspaceObjectFilterScalar | WorkspaceObjectFilterScalar[];

export const WorkspaceObjectFilterOperatorSchema = z.enum([
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not-in',
  'is-empty',
  'is-not-empty',
  'before',
  'after',
]);
export type WorkspaceObjectFilterOperator = z.infer<typeof WorkspaceObjectFilterOperatorSchema>;

export interface WorkspaceObjectFilterRule {
  type: 'rule';
  fieldId: string;
  operator: WorkspaceObjectFilterOperator;
  value?: WorkspaceObjectFilterValue;
}

export interface WorkspaceObjectFilterGroup {
  type: 'group';
  conjunction: 'and' | 'or';
  clauses: WorkspaceObjectFilterClause[];
}

export type WorkspaceObjectFilterClause = WorkspaceObjectFilterRule | WorkspaceObjectFilterGroup;

const WorkspaceObjectFilterValueSchema: z.ZodType<WorkspaceObjectFilterValue> = z.union([
  FilterScalarSchema,
  z.array(FilterScalarSchema).max(200),
]);

const WorkspaceObjectFilterRuleSchema: z.ZodType<WorkspaceObjectFilterRule> = z.strictObject({
  type: z.literal('rule'),
  fieldId: IdentifierSchema,
  operator: WorkspaceObjectFilterOperatorSchema,
  value: WorkspaceObjectFilterValueSchema.optional(),
}).superRefine((rule, context) => {
  const unary = rule.operator === 'is-empty' || rule.operator === 'is-not-empty';
  if (!unary && rule.value === undefined) {
    context.addIssue({ code: 'custom', path: ['value'], message: `${rule.operator} requires a value` });
  }
  if (unary && rule.value !== undefined) {
    context.addIssue({ code: 'custom', path: ['value'], message: `${rule.operator} does not accept a value` });
  }
  const setOperator = rule.operator === 'in' || rule.operator === 'not-in';
  if (setOperator && !Array.isArray(rule.value)) {
    context.addIssue({ code: 'custom', path: ['value'], message: `${rule.operator} requires an array value` });
  }
});

export const WorkspaceObjectFilterClauseSchema: z.ZodType<WorkspaceObjectFilterClause> = z.lazy(() => z.union([
  WorkspaceObjectFilterRuleSchema,
  z.strictObject({
    type: z.literal('group'),
    conjunction: z.enum(['and', 'or']),
    clauses: z.array(WorkspaceObjectFilterClauseSchema).min(1).max(50),
  }),
]));

function filterDepth(clause: WorkspaceObjectFilterClause): number {
  if (clause.type === 'rule') return 1;
  return 1 + Math.max(...clause.clauses.map(filterDepth));
}

export type WorkspaceObjectAdapterSetting =
  | string
  | number
  | boolean
  | null
  | WorkspaceObjectAdapterSetting[]
  | { [key: string]: WorkspaceObjectAdapterSetting };

const WorkspaceObjectAdapterSettingSchema: z.ZodType<WorkspaceObjectAdapterSetting> = z.lazy(() => z.union([
  z.string().max(64_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(WorkspaceObjectAdapterSettingSchema).max(200),
  z.record(z.string().max(120), WorkspaceObjectAdapterSettingSchema),
]));

export const WorkspaceObjectViewConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  search: z.string().max(500),
  filter: WorkspaceObjectFilterClauseSchema.nullable(),
  sort: z.array(z.strictObject({
    fieldId: IdentifierSchema,
    direction: z.enum(['asc', 'desc']),
  })).max(10),
  columnVisibility: z.record(IdentifierSchema, z.boolean()),
  presentation: z.strictObject({
    adapter: z.enum(['table', 'kanban', 'calendar', 'timeline', 'gallery', 'list']),
    settings: z.record(z.string().max(120), WorkspaceObjectAdapterSettingSchema),
  }),
}).superRefine((config, context) => {
  if (config.filter && filterDepth(config.filter) > 8) {
    context.addIssue({ code: 'custom', path: ['filter'], message: 'Filter nesting cannot exceed 8 levels' });
  }
  const duplicateSort = config.sort.find((sort, index) => config.sort.findIndex(candidate => candidate.fieldId === sort.fieldId) !== index);
  if (duplicateSort) {
    context.addIssue({ code: 'custom', path: ['sort'], message: `Duplicate sort field: ${duplicateSort.fieldId}` });
  }
});
export type WorkspaceObjectViewConfig = z.infer<typeof WorkspaceObjectViewConfigSchema>;

export const WorkspaceObjectSavedViewSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1).max(160),
  config: WorkspaceObjectViewConfigSchema,
});
export type WorkspaceObjectSavedView = z.infer<typeof WorkspaceObjectSavedViewSchema>;
export const WORKSPACE_OBJECT_SAVED_VIEW_CONFIG_MAX_BYTES = 64_000;
const UTF8_ENCODER = new TextEncoder();

const LegacyWorkspaceObjectSavedViewSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1).max(160),
  config: z.record(z.string(), z.unknown()),
});

function serializedConfigBytes(config: WorkspaceObjectViewConfig): number {
  return UTF8_ENCODER.encode(JSON.stringify(config)).byteLength;
}

function safePrefixLength(value: string, length: number): number {
  if (length <= 0 || length >= value.length) return Math.max(0, Math.min(length, value.length));
  const previous = value.charCodeAt(length - 1);
  const next = value.charCodeAt(length);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? length - 1
    : length;
}

function longestLegacyPrefixThatFits(
  serializedLegacy: string,
  build: (legacyConfig?: string) => WorkspaceObjectViewConfig,
): string | undefined {
  if (serializedConfigBytes(build(serializedLegacy)) <= WORKSPACE_OBJECT_SAVED_VIEW_CONFIG_MAX_BYTES) return serializedLegacy;
  let low = 0;
  let high = serializedLegacy.length;
  let best = 0;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const length = safePrefixLength(serializedLegacy, midpoint);
    if (serializedConfigBytes(build(serializedLegacy.slice(0, length))) <= WORKSPACE_OBJECT_SAVED_VIEW_CONFIG_MAX_BYTES) {
      best = Math.max(best, length);
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best > 0 ? serializedLegacy.slice(0, best) : undefined;
}

export function normalizeLegacyWorkspaceObjectSavedView(view: {
  id: string
  name: string
  config: Record<string, unknown>
}): WorkspaceObjectSavedView {
  const strict = WorkspaceObjectSavedViewSchema.safeParse(view)
  if (strict.success) return strict.data
  let serializedLegacy = '{}'
  try {
    serializedLegacy = JSON.stringify(view.config) ?? '{}'
  } catch {
    // Unsupported legacy values are preserved only when safely serializable.
  }
  const search = typeof view.config.search === 'string' ? view.config.search.slice(0, 500) : '';
  const columnEntries = Array.isArray(view.config.columns)
    ? view.config.columns
      .filter((fieldId): fieldId is string => typeof fieldId === 'string' && fieldId.length >= 1 && fieldId.length <= 120)
      .map(fieldId => [fieldId, true] as const)
    : [];
  const buildConfig = (visibleColumnCount: number, legacyConfig?: string): WorkspaceObjectViewConfig => ({
      ...DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW,
      search,
      columnVisibility: Object.fromEntries(columnEntries.slice(0, visibleColumnCount)),
      presentation: {
        adapter: 'table',
        settings: legacyConfig === undefined ? {} : { legacyConfig },
      },
  });
  let visibleColumnCount = columnEntries.length;
  if (serializedConfigBytes(buildConfig(visibleColumnCount)) > WORKSPACE_OBJECT_SAVED_VIEW_CONFIG_MAX_BYTES) {
    let low = 0;
    let high = visibleColumnCount;
    while (low < high) {
      const midpoint = Math.ceil((low + high) / 2);
      if (serializedConfigBytes(buildConfig(midpoint)) <= WORKSPACE_OBJECT_SAVED_VIEW_CONFIG_MAX_BYTES) low = midpoint;
      else high = midpoint - 1;
    }
    visibleColumnCount = low;
  }
  const buildBoundedConfig = (legacyConfig?: string): WorkspaceObjectViewConfig => buildConfig(visibleColumnCount, legacyConfig);
  const legacyConfig = serializedLegacy === '{}'
    ? undefined
    : longestLegacyPrefixThatFits(serializedLegacy, buildBoundedConfig);
  return WorkspaceObjectSavedViewSchema.parse({
    id: view.id,
    name: view.name,
    config: buildBoundedConfig(legacyConfig),
  })
}

export const WorkspaceObjectSavedViewInputSchema = z.union([
  WorkspaceObjectSavedViewSchema,
  LegacyWorkspaceObjectSavedViewSchema,
]).transform((view): WorkspaceObjectSavedView => {
  return normalizeLegacyWorkspaceObjectSavedView(view);
});
export type WorkspaceObjectSavedViewInput = z.input<typeof WorkspaceObjectSavedViewInputSchema>;

export const DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW: WorkspaceObjectViewConfig = {
  schemaVersion: 1,
  search: '',
  filter: null,
  sort: [],
  columnVisibility: {},
  presentation: { adapter: 'table', settings: {} },
};
