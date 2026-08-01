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

const LegacyWorkspaceObjectSavedViewSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1).max(160),
  config: z.record(z.string(), z.unknown()).refine(config => !('schemaVersion' in config), {
    message: 'Legacy saved views cannot declare schemaVersion',
  }),
});

export const WorkspaceObjectSavedViewInputSchema = z.union([
  WorkspaceObjectSavedViewSchema,
  LegacyWorkspaceObjectSavedViewSchema,
]).transform((view): WorkspaceObjectSavedView => {
  if ('schemaVersion' in view.config) return view as WorkspaceObjectSavedView;
  return {
    id: view.id,
    name: view.name,
    config: {
      ...DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW,
      search: typeof view.config.search === 'string' ? view.config.search : '',
      columnVisibility: Object.fromEntries(
        Array.isArray(view.config.columns)
          ? view.config.columns.filter((fieldId): fieldId is string => typeof fieldId === 'string').map(fieldId => [fieldId, true])
          : [],
      ),
      presentation: {
        adapter: 'table',
        settings: { legacyConfig: JSON.stringify(view.config) ?? '{}' },
      },
    },
  };
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
