/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, versions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - Claude SDK  → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi    → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the input/output schemas, description, handler
 * import, and one defineTool() entry in SESSION_TOOL_DEFS.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';

// Handlers
import { handleSubmitPlan } from './handlers/submit-plan.ts';
import { handleConfigValidate } from './handlers/config-validate.ts';
import { handleSkillValidate } from './handlers/skill-validate.ts';
import { handleMermaidValidate } from './handlers/mermaid-validate.ts';
import { handleSourceTest } from './handlers/source-test.ts';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './handlers/source-oauth.ts';
import { handleCredentialPrompt } from './handlers/credential-prompt.ts';
import { handleUpdatePreferences } from './handlers/update-preferences.ts';
import { handleTransformData } from './handlers/transform-data.ts';
import { handleScriptSandbox } from './handlers/script-sandbox.ts';
import { handleRenderTemplate } from './handlers/render-template.ts';
import { handleSendDeveloperFeedback } from './handlers/send-developer-feedback.ts';
import { handleSetSessionLabels } from './handlers/set-session-labels.ts';
import { handleSetSessionStatus } from './handlers/set-session-status.ts';
import { handleGetSessionInfo } from './handlers/get-session-info.ts';
import { handleListSessions } from './handlers/list-sessions.ts';
import { handleMemoryStore } from './handlers/memory-store.ts';
import { handleMemoryRecall } from './handlers/memory-recall.ts';
import { handleSendAgentMessage } from './handlers/send-agent-message.ts';
import { handleChannelDispatch } from './handlers/channel-dispatch.ts';
import { handleListMessagingChannels, handleUnbindMessagingChannel } from './handlers/messaging.ts';
import { handleListBackgroundTasks } from './handlers/list-background-tasks.ts';
import { handleWorkspaceObjects } from './handlers/workspace-objects.ts';

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const SubmitPlanSchema = z.object({
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
});

export const ConfigValidateSchema = z.object({
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'automations', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
});

export const SkillValidateSchema = z.object({
  skillSlug: z.string().describe('The slug of the skill to validate'),
});

export const MermaidValidateSchema = z.object({
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
});

export const SourceTestSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to test'),
  autoEnable: z
    .boolean()
    .optional()
    .describe(
      'Automatically enable and activate the source in the current session on successful validation. Defaults to true. Pass false to keep pure validation behavior.'
    ),
});

export const SourceOAuthTriggerSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
});

const WorkspaceObjectFieldSchema = z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  type: z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'select', 'status', 'relation', 'file']),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(160)).max(200).optional(),
  relationObjectId: z.string().min(1).max(120).optional(),
});

const WorkspaceObjectEntrySchema = z.strictObject({
  id: z.string().min(1).max(120),
  values: z.record(z.string().min(1).max(120), z.union([
    z.string().max(64_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ])),
});

type WorkspaceObjectFilterClause =
  | { type: 'rule'; fieldId: string; operator: string; value?: string | number | boolean | null | Array<string | number | boolean | null> }
  | { type: 'group'; conjunction: 'and' | 'or'; clauses: WorkspaceObjectFilterClause[] };

const WorkspaceObjectFilterValueSchema = z.union([
  z.string().max(64_000), z.number().finite(), z.boolean(), z.null(),
  z.array(z.union([z.string().max(64_000), z.number().finite(), z.boolean(), z.null()])).max(200),
]);
const WorkspaceObjectFilterRuleSchema = z.strictObject({
  type: z.literal('rule'),
  fieldId: z.string().min(1).max(120),
  operator: z.enum(['equals', 'not-equals', 'contains', 'not-contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not-in', 'is-empty', 'is-not-empty', 'before', 'after']),
  value: WorkspaceObjectFilterValueSchema.optional(),
});
function buildWorkspaceObjectFilterClauseSchema(depth: number): z.ZodType<WorkspaceObjectFilterClause> {
  if (depth === 1) return WorkspaceObjectFilterRuleSchema;
  const child = buildWorkspaceObjectFilterClauseSchema(depth - 1);
  return z.union([
    WorkspaceObjectFilterRuleSchema,
    z.strictObject({
      type: z.literal('group'),
      conjunction: z.enum(['and', 'or']),
      clauses: z.array(child).min(1).max(50),
    }),
  ]);
}
const WorkspaceObjectFilterClauseSchema = buildWorkspaceObjectFilterClauseSchema(8);
const WorkspaceObjectAdapterSettingScalarSchema = z.union([
  z.string().max(64_000), z.number().finite(), z.boolean(), z.null(),
]);
const WorkspaceObjectAdapterSettingSchema = z.union([
  WorkspaceObjectAdapterSettingScalarSchema,
  z.array(WorkspaceObjectAdapterSettingScalarSchema).max(200),
]);
const WorkspaceObjectViewConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  search: z.string().max(500),
  filter: WorkspaceObjectFilterClauseSchema.nullable(),
  sort: z.array(z.strictObject({ fieldId: z.string().min(1).max(120), direction: z.enum(['asc', 'desc']) })).max(10),
  columnVisibility: z.record(z.string().min(1).max(120), z.boolean()),
  presentation: z.strictObject({
    adapter: z.enum(['table', 'kanban', 'calendar', 'timeline', 'gallery', 'list']),
    settings: z.record(z.string().max(120), WorkspaceObjectAdapterSettingSchema),
  }),
});
const WorkspaceObjectSavedViewSchema = z.union([z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  config: WorkspaceObjectViewConfigSchema,
}), z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  config: z.record(z.string(), z.unknown()).refine(config => !('schemaVersion' in config), {
    message: 'Legacy saved views cannot declare schemaVersion',
  }),
})]);

const WorkspaceObjectDefinitionSchema = z.strictObject({
  id: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  name: z.string().min(1).max(160),
  fields: z.array(WorkspaceObjectFieldSchema).max(200),
});

const WorkspaceObjectIdSchema = z.string().min(1).max(120);

export const WorkspaceObjectsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('define-object'), object: WorkspaceObjectDefinitionSchema }),
  z.strictObject({
    action: z.literal('upsert-entries'),
    objectId: WorkspaceObjectIdSchema,
    entries: z.array(WorkspaceObjectEntrySchema).min(1).max(200),
  }),
  z.strictObject({
    action: z.literal('delete-entries'),
    objectId: WorkspaceObjectIdSchema,
    entryIds: z.array(z.string().min(1).max(120)).min(1).max(200),
  }),
  z.strictObject({ action: z.literal('upsert-view'), objectId: WorkspaceObjectIdSchema, view: WorkspaceObjectSavedViewSchema }),
  z.strictObject({ action: z.literal('get-object'), objectId: WorkspaceObjectIdSchema }),
  z.strictObject({ action: z.literal('list-objects'), limit: z.number().int().min(1).max(200).optional() }),
  z.strictObject({ action: z.literal('repair-projection'), objectId: WorkspaceObjectIdSchema }),
  z.strictObject({
    action: z.literal('query-object'), objectId: WorkspaceObjectIdSchema,
    query: z.union([
      z.strictObject({ viewId: WorkspaceObjectIdSchema }),
      z.strictObject({ config: WorkspaceObjectViewConfigSchema }),
    ]),
  }),
]);

// Claude SDK's tool() API still requires a Zod object shape. Canonical validation
// remains WorkspaceObjectsSchema; this envelope only describes the union frontier
// to the native adapter before executeSessionTool() performs action-specific parse.
const WorkspaceObjectsNativeSchema = z.strictObject({
  action: z.enum(['define-object', 'upsert-entries', 'delete-entries', 'upsert-view', 'get-object', 'list-objects', 'repair-projection', 'query-object']),
  object: WorkspaceObjectDefinitionSchema.optional(),
  objectId: WorkspaceObjectIdSchema.optional(),
  entries: z.array(WorkspaceObjectEntrySchema).min(1).max(200).optional(),
  entryIds: z.array(z.string().min(1).max(120)).min(1).max(200).optional(),
  view: WorkspaceObjectSavedViewSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.union([
    z.strictObject({ viewId: WorkspaceObjectIdSchema }),
    z.strictObject({ config: WorkspaceObjectViewConfigSchema }),
  ]).optional(),
});

export const CredentialPromptSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
});

export const CallLlmSchema = z.object({
  prompt: z.string().describe('Instructions for the LLM'),
  attachments: z.array(z.union([
    z.string().describe('Simple file path'),
    z.object({
      path: z.string().describe('File path'),
      startLine: z.number().optional().describe('First line (1-indexed)'),
      endLine: z.number().optional().describe('Last line (1-indexed)'),
    }),
  ])).optional().describe('File paths on disk to attach (max 20). NOT for inline text — put text in prompt instead. Use {path, startLine, endLine} for large files.'),
  model: z.string().optional().describe('Model ID or short name. Defaults to a fast model.'),
  systemPrompt: z.string().optional().describe('Optional system prompt'),
  maxTokens: z.number().optional().describe('Max output tokens (1-64000). Defaults to 4096'),
  temperature: z.number().optional().describe('Sampling temperature 0-1'),
  thinking: z.boolean().optional().describe('Enable extended thinking. Incompatible with outputFormat/outputSchema'),
  thinkingBudget: z.number().optional().describe('Token budget for thinking (1024-100000). Defaults to 10000'),
  outputFormat: z.enum(['summary', 'classification', 'extraction', 'analysis', 'comparison', 'validation']).optional()
    .describe('Predefined output format'),
  outputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }).optional().describe('Custom JSON Schema for structured output'),
});

export const UpdatePreferencesSchema = z.object({
  name: z.string().optional().describe("The user's preferred name or how they'd like to be addressed"),
  timezone: z.string().optional().describe("The user's timezone in IANA format (e.g., 'America/New_York', 'Europe/London')"),
  city: z.string().optional().describe("The user's city"),
  region: z.string().optional().describe("The user's state/region/province"),
  country: z.string().optional().describe("The user's country"),
  notes: z.string().optional().describe('Additional notes about the user that would be helpful to remember (preferences, context, etc.). Replaces any existing notes.'),
  includeCoAuthoredBy: z.boolean().optional().describe("Whether to include 'Co-Authored-By: Craft Agent' trailer on git commits. Defaults to true."),
});

export const TransformDataSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
});

export const ScriptSandboxSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Inline script source to execute in a sandboxed subprocess.'),
  inputFiles: z.array(z.string()).optional().describe('Optional input file paths relative to the session directory.'),
  stdin: z.string().optional().describe('Optional stdin payload passed to the script process.'),
  timeoutMs: z.number().min(1).max(15000).optional().describe('Optional timeout in milliseconds (default 5000, max 15000).'),
});

export const RenderTemplateSchema = z.object({
  source: z.string().describe('Source slug (e.g., "linear", "gmail")'),
  template: z.string().describe('Template ID (e.g., "issue-detail", "issue-list")'),
  data: z.record(z.string(), z.unknown()).describe('JSON data to render into the template'),
});

export const SendDeveloperFeedbackSchema = z.object({
  message: z.string().describe('Freeform markdown feedback — be detailed, use headings, lists, code blocks. Include what happened, what you expected, what would help, or any ideas/suggestions.'),
});

// Browser tool schema (single CLI-like tool for all browser actions)
export const BrowserToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
});

export const SpawnSessionSchema = z.object({
  help: z.boolean().optional().describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  llmConnection: z.string().optional().describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional().describe('Model ID override'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode for the new session'),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
  labels: z.array(z.string()).optional().describe('Labels for the new session'),
  workingDirectory: z.string().optional().describe('Working directory for the new session'),
  projectId: z.string().optional().describe('Workspace project id to bind the new session to. Inherits the project working directory unless overridden.'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the prompt'),
});

// Session self-management tools
const SetSessionLabelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  labels: z.array(z.string()).describe('Labels to set (replaces all existing labels)'),
});

const SetSessionStatusSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  status: z.string().describe('Status to set (e.g., "todo", "in_progress", "done")'),
});

const GetSessionInfoSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to get info about the current session.'),
});

const ListBackgroundTasksSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to list background tasks for. Omit to use the current session.'),
});

const ListSessionsSchema = z.object({
  status: z.string().optional().describe('Filter by status'),
  label: z.string().optional().describe('Filter by label'),
  search: z.string().optional().describe('Substring match on session name'),
  sortBy: z.enum(['recent', 'name', 'status']).optional().describe('Sort order (default: recent)'),
  limit: z.number().optional().describe('Max sessions to return (default 20, max 100)'),
  offset: z.number().optional().describe('Skip first N results (for pagination)'),
});

// Memory tools
const MemoryStoreSchema = z.object({
  action: z.enum(['add', 'replace', 'remove']).describe('Action: add new, replace existing, or remove entry'),
  target: z.enum(['agent', 'user']).describe("'user' for user profile, 'agent' for agent notes"),
  category: z.enum(['profile', 'event', 'knowledge', 'behavior', 'skill']).describe('Memory category'),
  content: z.string().optional().describe('Entry content (required for add/replace)'),
  old_text: z.string().optional().describe('Unique substring to identify entry (required for replace/remove)'),
  tags: z.array(z.string()).optional().describe('Tags for organization'),
});

const MemoryRecallSchema = z.object({
  query: z.string().describe('Search query to find relevant memories'),
  target: z.enum(['agent', 'user']).optional().describe('Filter by target'),
  category: z.enum(['profile', 'event', 'knowledge', 'behavior', 'skill']).optional().describe('Filter by category'),
  limit: z.number().optional().describe('Max results (default 10)'),
});

// Inter-session messaging
const SendAgentMessageSchema = z.object({
  sessionId: z.string().describe('Target session ID to send the message to'),
  message: z.string().describe('The message to send to the target session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the message'),
});

export const ChannelDispatchSchema = z.object({
  participantId: z.string().describe('Channel participant id to dispatch work to, e.g. "reviewer"'),
  message: z.string().describe('Task or message to route to the participant in the same channel'),
  channelId: z.string().optional().describe('Channel id. Omit when the current session is already bound to a channel.'),
  parentMessageId: z.string().optional().describe('Optional channel message id this dispatch should be linked to'),
});

const ListMessagingChannelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to list bindings for. Defaults to current session.'),
});

const UnbindMessagingChannelSchema = z.object({
  platform: z.enum(['telegram', 'whatsapp', 'lark']).optional().describe('Platform to unbind. If omitted, unbinds all.'),
});

// MCP-only bridge tools (executed by the in-process Hermes bridge, not the registry)
const AutomationToolSchema = z.object({
  command: z.enum(['list', 'create_scheduled', 'toggle', 'delete', 'history']),
  id: z.string().optional().describe('Automation matcher id for toggle/delete/history filtering'),
  name: z.string().optional().describe('Human-readable automation name'),
  cron: z.string().optional().describe('5-field cron expression for SchedulerTick, e.g. */30 * * * *'),
  timezone: z.string().optional().describe('IANA timezone, e.g. America/Sao_Paulo'),
  prompt: z.string().optional().describe('Prompt action text for create_scheduled'),
  llmConnection: z.string().optional().describe('Optional LLM connection slug for the spawned automation session'),
  model: z.string().optional().describe('Optional model id for the spawned automation session'),
  labels: z.array(z.string()).optional().describe('Labels applied to sessions created by the automation'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode for created sessions'),
  enabled: z.boolean().optional().describe('Enable/disable value for create_scheduled or toggle'),
  limit: z.number().optional().describe('History entry limit, default 20'),
});

const MeetingToolSchema = z.object({
  command: z.enum(['start', 'status', 'list', 'transcript', 'stop']),
  meetingId: z.string().optional().describe('Meeting/capture id for status, transcript, or stop'),
  id: z.string().optional().describe('Alias for meetingId when native callbacks use id'),
  title: z.string().optional().describe('Optional meeting title for start'),
  url: z.string().optional().describe('Optional meeting URL for start/attach'),
  limit: z.number().optional().describe('Optional result limit for list/transcript'),
});

// ============================================================
// Canonical Tool Descriptions (base — no DOC_REFS)
// ============================================================

export const TOOL_DESCRIPTIONS = {
  workspace_objects: `Create, update, query, and repair structured workspace objects through one validated workspace-scoped data plane. SQLite is canonical; manifests are derived. Never use raw SQL or place secrets in values intended for manifests.`,
  SubmitPlan: `Submit a plan for user review.

Call this after you have written your plan to a markdown file using the Write tool.
The plan will be displayed to the user in a special formatted view.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to present the plan to the user
- No further tool calls or text output will be processed after this tool returns
- The conversation will resume when the user responds (accept, modify, or reject the plan)
- Do NOT include any text or tool calls after SubmitPlan - they will not be executed`,

  config_validate: `Validate Craft Agent configuration files.

Use this after editing configuration files to check for errors before they take effect.
Returns structured validation results with errors, warnings, and suggestions.

**Targets:**
- \`config\`: Validates config.json (workspaces, model, settings)
- \`sources\`: Validates all source config.json files
- \`statuses\`: Validates statuses config.json
- \`preferences\`: Validates preferences.json
- \`permissions\`: Validates permissions.json files
- \`automations\`: Validates automations.json configuration
- \`tool-icons\`: Validates tool-icons.json
- \`all\`: Validates all configuration files`,

  skill_validate: `Validate a skill's SKILL.md file.

Checks:
- Slug format (lowercase alphanumeric with hyphens)
- SKILL.md exists and is readable
- YAML frontmatter is valid with required fields (name, description)
- Content is non-empty after frontmatter
- Icon format if present (svg/png/jpg)`,

  mermaid_validate: `Validate Mermaid diagram syntax before outputting.

Use this when:
- Creating complex diagrams with many nodes/relationships
- Unsure about syntax for a specific diagram type
- Debugging a diagram that failed to render

Returns validation result with specific error messages if invalid.`,

  source_test: `Validate, test, and (by default) activate a source configuration.

**This tool performs:**
1. **Schema validation**: Validates config.json structure
2. **Icon handling**: Checks/downloads icon if configured
3. **Completeness check**: Warns about missing guide.md/icon/tagline
4. **Connection test**: Tests if the source is reachable
5. **Auth status**: Checks if source is authenticated
6. **Auto-enable** (default): If validation passes, flip \`enabled: true\` in config (if needed) and activate the source in the running session so its tools become available without a restart.

Pass \`autoEnable: false\` to keep pure validation behavior (no config or session mutations).`,

  source_oauth_trigger: `Start OAuth authentication for an MCP source.

This tool initiates the OAuth 2.0 + PKCE flow for sources that require authentication.

**Prerequisites:**
- Source must exist in the current workspace
- Source must be type 'mcp' with authType 'oauth'
- Source must have a valid MCP URL

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_google_oauth_trigger: `Trigger Google OAuth authentication for a Google API source.

Opens a browser window for the user to sign in with their Google account.

**Supported services:** Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_slack_oauth_trigger: `Trigger Slack OAuth authentication for a Slack API source.

Opens a browser window for the user to sign in with their Slack account.

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth authentication for a Microsoft API source.

Opens a browser window for the user to sign in with their Microsoft account.

**Supported services:** Outlook, Calendar, OneDrive, Teams, SharePoint

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_credential_prompt: `Prompt the user to enter credentials for a source.

Use this when a source requires authentication that isn't OAuth.
The user will see a secure input UI with appropriate fields based on the auth mode.

**Auth Modes:**
- \`bearer\`: Single token field (Bearer Token, API Key)
- \`basic\`: Username and Password fields
- \`header\`: API Key with custom header name shown
- \`query\`: API Key for query parameter auth
- \`multi-header\`: Multiple API keys with custom header names

**IMPORTANT:** After calling this tool, execution will be paused for user input.`,

  update_user_preferences: `Update stored user preferences. Use this when you learn information about the user that would be helpful to remember for future conversations. This includes their name, timezone, location, or any other relevant notes. Only update fields you have confirmed information about - don't guess.`,

  transform_data: `Transform data files using a script and write structured output for datatable/spreadsheet blocks, or extract HTML content for html-preview blocks.

Use this tool when you need to transform large datasets (20+ rows) into structured JSON for display, or extract/decode content for rich previews. Write a transform script that reads the input file and produces an output file, then reference it via \`"src"\` in your datatable/spreadsheet/html-preview/pdf-preview/image-preview block.

**Workflow:**
1. Call \`transform_data\` with a script that reads input files and writes output
2. Output a datatable/spreadsheet block with \`"src": "data/output.json"\`, an html-preview block with \`"src": "data/output.html"\`, a pdf-preview block with \`"src": "data/output.pdf"\`, or an image-preview block with \`"src": "data/output.png"\`

**Script conventions:**
- Input file paths are passed as command-line arguments (last arg = output file path)
- Python: \`sys.argv[1:-1]\` = input files, \`sys.argv[-1]\` = output path
- Node/Bun: \`process.argv.slice(2, -1)\` = input files, \`process.argv.at(-1)\` = output path
- For datatable/spreadsheet: output must be valid JSON: \`{"title": "...", "columns": [...], "rows": [...]}\`
- For html-preview: output is an HTML file (any valid HTML)

**Security:** Runs in an isolated subprocess with no access to API keys or credentials. 30-second timeout.`,

  script_sandbox: `Run quick inline diagnostics in a sandboxed subprocess with network isolation.

Use this for short Python/Node/Bun snippets when strict Explore-mode Bash parsing blocks inline diagnostics.

**Behavior:**
- Executes script source from \`script\` in a temporary file
- Returns stdout/stderr, exit code, duration, and timeout status
- Accepts optional input files and stdin
- Requires enforced network and filesystem isolation; if unsupported or unusable, execution is blocked

**Safety:**
- Sensitive credential env vars are stripped
- Input files are restricted to the current session directory
- Filesystem writes are restricted to the current session directory
- Timeout is capped (default 5000ms, max 15000ms)
- Network/filesystem isolation is required in all permission modes; if unavailable, execution is blocked`,

  render_template: `Render a source's HTML template with data.

Use this when a source provides HTML templates for rich rendering of its data (e.g., issue detail views, email threads, ticket summaries).

**Workflow:**
1. Fetch data from the source (via MCP tools or API calls)
2. Call \`render_template\` with the source slug, template ID, and data
3. Output an \`html-preview\` block with the returned file path as \`"src"\`

**Available templates** are documented in each source's \`guide.md\` under the "Templates" section.

Templates use Mustache syntax — the tool handles rendering and writes the output HTML to the session data folder.`,

  browser_tool: `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`drag 100 200 300 400\` — drag from (100,200) to (300,400)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`upload @e3 /path/to/file.pdf\` — attach local file(s) to a file input
- \`scroll down 800\`
- \`evaluate document.title\`
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus existing browser window (no new window)
- \`windows\` — list current browser windows and ownership state
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close and destroy the browser window
- \`hide [windowId]\` — hide the window while preserving state`,

  call_llm: `Invoke a secondary LLM for focused subtasks. Use for:
- Cost optimization: use a smaller model for simple tasks (summarization, classification)
- Structured output: JSON schema compliance — native when the backend supports it (e.g. Claude), via prompt instructions otherwise (Pi/Hermes)
- Parallel processing: call multiple times in one message - all run simultaneously
- Context isolation: process content without polluting main context

Put text/content directly in the 'prompt' parameter. Do NOT pass inline text via attachments.
Only use 'attachments' for existing file paths on disk - the tool loads file content automatically.
For large files (>2000 lines), use {path, startLine, endLine} to select a portion.`,

  spawn_session: `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: \`model\`, \`llmConnection\`, \`permissionMode\`, \`thinkingLevel\`, \`enabledSourceSlugs\`, \`labels\`, \`workingDirectory\`. Omitted fields inherit from the spawning session or the workspace default.

\`thinkingLevel\` is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring. Use it when you want to force deeper reasoning on a supported model, or set it to \`off\` when spawning a session that doesn't need to think.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,

  send_developer_feedback: `Send freeform feedback to the Craft Agent development team.

Use this to share anything that would help improve the product — issues you hit, ideas for better tools, suggestions for improved workflows, or patterns you notice. Write in markdown with as much detail as possible. This is your direct line to the developers.`,

  set_session_labels: `Set labels on the current session or a specific session by ID. Replaces all existing labels.

Use this to tag sessions for filtering or to trigger label-based automations (LabelAdd/LabelRemove events).
Pass an empty array to clear all labels. Omit sessionId to target the current session.`,

  set_session_status: `Set the status of the current session or a specific session by ID (e.g., "todo", "in_progress").

Use this to reflect progress or trigger status-based automations (SessionStatusChange events).
Omit sessionId to target the current session.

IMPORTANT: never move a task into a closed status (such as "done" or "cancelled") yourself — closing a task is the user's decision, made on the board. You may prepare and hand off work by setting an open status like "needs-review"; the user reviews and closes it. Closed-status calls are rejected.`,

  get_session_info: `Get metadata about the current session or a specific session by ID.

Returns labels, status, name, permission mode, projectId (if the session is bound to a project), workingDirectory, and other details.
Call with no arguments to introspect your own session state.`,

  list_sessions: `List sessions in the workspace. Returns total count + paginated results.

Use filters (status, label, search) to narrow results instead of fetching everything. Default limit is 20 sessions.
Use get_session_info for full details on a specific session (list-then-detail pattern).`,

  list_background_tasks: `Enumerate the background agents/tasks tracked for a session by the main-process registry (running, finished, or orphaned).

This is the ONLY reliable way to answer "what is running / what's the status?" — it reads the main-process registry, which tracks tasks across turns. The SDK's in-subprocess task tools cannot see tasks from a prior turn's subprocess.

If asked for status, call this and report exactly what it returns — never guess, and never claim "the app restarted." A \`status: 'orphaned'\` task ended when its owning turn's subprocess was torn down; its in-process state was lost.`,

  memory_store: `Save durable information to persistent memory that survives across sessions.

WHEN TO SAVE (proactively, don't wait to be asked):
- User corrects you or says "remember this"
- User shares a preference, habit, or personal detail
- You discover something about the environment (tools, project structure)
- You learn a convention or workflow specific to this user's setup

TWO TARGETS:
- 'user': who the user is — name, role, preferences, communication style
- 'agent': your notes — environment facts, project conventions, lessons learned

ACTIONS: add (new entry), replace (update existing via old_text), remove (delete via old_text).
Skip trivial info, task progress, or temporary state.`,

  memory_recall: `Search persistent memory for relevant information from past sessions.

Returns memories ranked by salience (relevance × reinforcement × recency).
Use when you need context from previous conversations or to check what you know about the user/project.`,

  send_agent_message: `Send a message to another session. The message is delivered with your session ID so the target can reply back.

Use this to coordinate with spawned sessions, send follow-up instructions, or relay information between sessions.
Use list_sessions to find session IDs, or use the sessionId returned by spawn_session.

The target session receives your message with a sender envelope containing your session ID, so it can use send_agent_message to reply.`,

  channel_dispatch: `Dispatch work to another participant in the current War Room channel.

Use this from a channel lead/orchestrator session when another configured channel participant should handle a task in the same shared room. The dispatch is recorded durably, the task is appended to the channel log, and the participant's Craft session receives the work.

Provide participantId and message. Omit channelId when the current session was created by channel routing; include it only when the runtime cannot infer the current channel.`,

  list_messaging_channels: `List messaging channels (Telegram, WhatsApp, Lark) bound to a session.
Shows which external chat apps are connected and can send/receive messages.`,

  unbind_messaging_channel: `Disconnect a messaging channel from the current session.
Messages will no longer be forwarded between the chat app and this session.`,

  automation_tool: `Manage Craft-native automations for this workspace.

Use this instead of Hermes native cron while running inside Craft. Scheduled prompt jobs are written to the workspace automations.json and appear in Craft Automations / Scheduled.

Commands:
- list: list configured automations
- create_scheduled: create a SchedulerTick automation that starts a Craft session with a prompt
- toggle: enable or disable an automation by id
- delete: remove an automation by id
- history: read recent automations-history.jsonl entries`,

  meeting_tool: `Control Craft-native meeting capture for this session when desktop/native meeting callbacks are available.

Commands:
- start: start or attach to a meeting capture
- status: get current meeting capture status
- list: list known/recent meeting captures
- transcript: fetch a meeting transcript
- stop: stop an active meeting capture

If the active Craft runtime has not registered meeting callbacks, this tool returns a clear unavailable error instead of touching Hermes upstream.`,
} as const;

// ============================================================
// Tool Definition Type
// ============================================================

export const SESSION_TOOLS_FRONTIER_API_VERSION = 'v1' as const;

export type SessionToolApiVersion = typeof SESSION_TOOLS_FRONTIER_API_VERSION | 'v2';

/**
 * Where a session tool may be exposed:
 * - `native-and-mcp`: available to native backends (Claude/Pi) and every MCP bridge.
 * - `mcp-only`: available only through an MCP bridge (e.g. the Hermes in-process
 *   bridge), never surfaced to native backends.
 */
export type SessionToolExposure = 'native-and-mcp' | 'mcp-only';

export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageContentSchema = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string(),
});

export const ToolResultOutputSchema = z.object({
  content: z.array(z.union([TextContentSchema, ImageContentSchema])),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: any) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

/** Safe/Explore mode behavior for a session tool. */
export type SessionToolSafeMode = 'allow' | 'block';

interface SessionToolDefBase {
  name: string;
  apiVersion: SessionToolApiVersion;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Object-only transport envelope for native SDKs whose tool API cannot accept unions. */
  nativeInputSchema?: z.ZodObject<z.ZodRawShape>;
  outputSchema: z.ZodTypeAny;
  exposure: SessionToolExposure;
  /** Whether this tool is allowed in Explore/Safe mode. */
  safeMode: SessionToolSafeMode;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
}

/**
 * Tool executed from the canonical registry. The concrete handler is held in a
 * module-private table (REGISTRY_HANDLERS) and is only reachable through
 * executeSessionTool(); it is intentionally NOT a property of the def, so no
 * consumer can invoke it directly and skip input/output validation.
 */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
}

/** Tool executed by backend-specific adapters (Pi/Claude/session-mcp-server). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
}

/** A single session tool definition combining name, description, schema, and mode. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

type DefineToolConfig = Omit<SessionToolDefBase, 'name' | 'apiVersion'> & {
  version: SessionToolApiVersion;
} & (
  | { executionMode: 'registry'; handler: SessionToolHandler }
  | { executionMode: 'backend'; handler: null }
);

/**
 * Module-private handler table. Handlers are deliberately kept off SessionToolDef
 * so no consumer outside this module can invoke a tool's handler directly and
 * skip input/output validation. The only execution path is executeSessionTool().
 */
const REGISTRY_HANDLERS = new WeakMap<SessionToolDef, SessionToolHandler>();

/**
 * Canonical registration entry point for session tools exposed as the frontier API.
 */
// react-doctor-disable-next-line agent-tool-capability-risk -- generic session-tool factory; every tool's inputs are zod-validated via inputSchema.parse (validateSessionToolInput) and exposure/safeMode/readOnly gates are declared per tool; no unguarded capability
export function defineTool(name: string, config: DefineToolConfig): SessionToolDef {
  const def: SessionToolDef = {
    name,
    apiVersion: config.version,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.nativeInputSchema ? { nativeInputSchema: config.nativeInputSchema } : {}),
    outputSchema: config.outputSchema,
    exposure: config.exposure,
    safeMode: config.safeMode,
    ...(config.readOnly !== undefined ? { readOnly: config.readOnly } : {}),
    executionMode: config.executionMode,
  } as SessionToolDef;
  if (config.handler) {
    REGISTRY_HANDLERS.set(def, config.handler);
  }
  return def;
}

export function validateSessionToolInput(def: SessionToolDef, args: unknown): Record<string, unknown> {
  return def.inputSchema.parse(args) as Record<string, unknown>;
}

export function validateSessionToolOutput(def: SessionToolDef, result: unknown): ToolResult {
  return def.outputSchema.parse(result);
}

/**
 * Execute a registry session tool by name. Resolves the canonical definition,
 * validates the input against inputSchema, runs the module-private handler, and
 * validates the result against outputSchema.
 *
 * `filterOptions` defaults to the full catalog when omitted, so a direct call
 * like executeSessionTool('memory_store', ...) resolves instead of 404ing;
 * feature gating lives in the tool listing, not in execution. The production
 * callers pass their own filterOptions and are unaffected.
 *
 * Throws when the name is unknown/unavailable, or resolves to a backend-executed
 * tool (call_llm, spawn_session, browser_tool) — those are run by their backend
 * adapters, not through this function.
 */
export async function executeSessionTool(
  name: string,
  ctx: SessionToolContext,
  args: unknown,
  filterOptions?: SessionToolFilterOptions,
): Promise<ToolResult> {
  const def = getSessionToolRegistry(filterOptions ?? { includeDeveloperFeedback: true, includeMemory: true }).get(name);
  if (!def) {
    throw new Error(`Unknown or unavailable session tool: ${name}`);
  }
  const handler = REGISTRY_HANDLERS.get(def);
  if (!handler) {
    throw new Error(`Session tool '${name}' is backend-executed (${def.executionMode}) and has no canonical handler.`);
  }
  const parsedArgs = validateSessionToolInput(def, args);
  const result = await handler(ctx, parsedArgs);
  return validateSessionToolOutput(def, result);
}

const FRONTIER_TOOL_DEFAULTS = {
  version: SESSION_TOOLS_FRONTIER_API_VERSION,
  outputSchema: ToolResultOutputSchema,
  exposure: 'native-and-mcp' as const,
};

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  defineTool('workspace_objects', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.workspace_objects, inputSchema: WorkspaceObjectsSchema, nativeInputSchema: WorkspaceObjectsNativeSchema, executionMode: 'registry', safeMode: 'block', handler: handleWorkspaceObjects }),
  defineTool('SubmitPlan', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.SubmitPlan, inputSchema: SubmitPlanSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSubmitPlan }),
  defineTool('config_validate', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.config_validate, inputSchema: ConfigValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleConfigValidate }),
  defineTool('skill_validate', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.skill_validate, inputSchema: SkillValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleSkillValidate }),
  defineTool('mermaid_validate', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.mermaid_validate, inputSchema: MermaidValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleMermaidValidate }),
  defineTool('source_test', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_test, inputSchema: SourceTestSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSourceTest }),
  defineTool('source_oauth_trigger', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSourceOAuthTrigger }),
  defineTool('source_google_oauth_trigger', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_google_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleGoogleOAuthTrigger }),
  defineTool('source_slack_oauth_trigger', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_slack_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSlackOAuthTrigger }),
  defineTool('source_microsoft_oauth_trigger', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleMicrosoftOAuthTrigger }),
  defineTool('source_credential_prompt', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.source_credential_prompt, inputSchema: CredentialPromptSchema, executionMode: 'registry', safeMode: 'block', handler: handleCredentialPrompt }),
  defineTool('update_user_preferences', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.update_user_preferences, inputSchema: UpdatePreferencesSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdatePreferences }),
  defineTool('transform_data', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.transform_data, inputSchema: TransformDataSchema, executionMode: 'registry', safeMode: 'allow', handler: handleTransformData }),
  defineTool('script_sandbox', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.script_sandbox, inputSchema: ScriptSandboxSchema, executionMode: 'registry', safeMode: 'allow', handler: handleScriptSandbox }),
  defineTool('render_template', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.render_template, inputSchema: RenderTemplateSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRenderTemplate }),
  defineTool('send_developer_feedback', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.send_developer_feedback, inputSchema: SendDeveloperFeedbackSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSendDeveloperFeedback }),
  defineTool('call_llm', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.call_llm, inputSchema: CallLlmSchema, executionMode: 'backend', safeMode: 'allow', readOnly: true, handler: null }),
  defineTool('spawn_session', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null }),
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  defineTool('browser_tool', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null }),
  // Session self-management tools (registry — use context callbacks to reach SessionManager)
  defineTool('set_session_labels', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.set_session_labels, inputSchema: SetSessionLabelsSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionLabels }),
  defineTool('set_session_status', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.set_session_status, inputSchema: SetSessionStatusSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionStatus }),
  defineTool('get_session_info', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.get_session_info, inputSchema: GetSessionInfoSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetSessionInfo }),
  defineTool('list_sessions', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListSessions }),
  defineTool('list_background_tasks', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.list_background_tasks, inputSchema: ListBackgroundTasksSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListBackgroundTasks }),
  // Memory tools (feature-flagged — handlers gracefully degrade when memory is disabled)
  defineTool('memory_store', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.memory_store, inputSchema: MemoryStoreSchema, executionMode: 'registry', safeMode: 'block', handler: handleMemoryStore }),
  defineTool('memory_recall', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.memory_recall, inputSchema: MemoryRecallSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleMemoryRecall }),
  // Inter-session messaging
  defineTool('send_agent_message', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.send_agent_message, inputSchema: SendAgentMessageSchema, executionMode: 'registry', safeMode: 'block', handler: handleSendAgentMessage }),
  defineTool('channel_dispatch', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.channel_dispatch, inputSchema: ChannelDispatchSchema, executionMode: 'registry', safeMode: 'block', handler: handleChannelDispatch }),
  // Messaging gateway tools
  defineTool('list_messaging_channels', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.list_messaging_channels, inputSchema: ListMessagingChannelsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListMessagingChannels }),
  defineTool('unbind_messaging_channel', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.unbind_messaging_channel, inputSchema: UnbindMessagingChannelSchema, executionMode: 'registry', safeMode: 'block', handler: handleUnbindMessagingChannel }),
];

/**
 * MCP-only tools: declared through defineTool (the same contract machinery as
 * the canonical catalog) with exposure 'mcp-only'. They are intentionally NOT
 * part of SESSION_TOOL_DEFS, so native backends (Claude/Pi) and
 * getToolDefsAsJsonSchema never surface them. Only an MCP bridge that implements
 * their execution (the in-process Hermes bridge) exposes and runs them.
 */
export const MCP_ONLY_TOOL_DEFS: SessionToolDef[] = [
  defineTool('automation_tool', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.automation_tool, inputSchema: AutomationToolSchema, exposure: 'mcp-only', executionMode: 'backend', safeMode: 'block', handler: null }),
  defineTool('meeting_tool', { ...FRONTIER_TOOL_DEFAULTS, description: TOOL_DESCRIPTIONS.meeting_tool, inputSchema: MeetingToolSchema, exposure: 'mcp-only', executionMode: 'backend', safeMode: 'block', handler: null }),
];

export interface SessionToolFilterOptions {
  /** Include the experimental send_developer_feedback tool. */
  includeDeveloperFeedback?: boolean;
  /** Include memory tools (memory_store, memory_recall). */
  includeMemory?: boolean;
  /** Include structured-object guidance/tooling only for compatible workspaces. */
  includeWorkspaceObjects?: boolean;
}

const MEMORY_TOOL_NAMES = new Set(['memory_store', 'memory_recall']);

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across Claude, Pi, and session-mcp-server backends.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;
  const includeMemory = options?.includeMemory ?? false;
  const includeWorkspaceObjects = options?.includeWorkspaceObjects ?? true;

  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
      return false;
    }
    if (!includeMemory && MEMORY_TOOL_NAMES.has(def.name)) {
      return false;
    }
    if (!includeWorkspaceObjects && def.name === 'workspace_objects') return false;
    return true;
  });
}

/**
 * Build a name->definition registry with optional feature filtering.
 */
export function getSessionToolRegistry(options?: SessionToolFilterOptions): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs(options).map(def => [def.name, def]));
}

/**
 * Return session tool names with optional feature filtering.
 */
export function getSessionToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).map(def => def.name));
}

/**
 * Return backend-executed tool names with optional feature filtering.
 */
export function getSessionBackendToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).flatMap(d => d.executionMode === 'backend' ? [d.name] : []));
}

/**
 * Return registry-executed tool names with optional feature filtering.
 */
export function getSessionRegistryToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).flatMap(d => d.executionMode === 'registry' ? [d.name] : []));
}

export interface SessionToolNameOptions extends SessionToolFilterOptions {
  /** Optional name prefix for consumers (e.g. 'mcp__session__'). */
  prefix?: string;
}

/**
 * Return session tool names that are allowed in Explore/Safe mode.
 */
export function getSessionSafeAllowedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .flatMap(def => def.safeMode === 'allow' ? [`${prefix}${def.name}`] : [])
  );
}

/**
 * Return session tool names that are blocked in Explore/Safe mode.
 */
export function getSessionSafeBlockedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .flatMap(def => def.safeMode === 'block' ? [`${prefix}${def.name}`] : [])
  );
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude/session-mcp-server). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.flatMap(d => d.executionMode === 'backend' ? [d.name] : [])
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.flatMap(d => d.executionMode === 'registry' ? [d.name] : [])
);

/** Session tool names allowed in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_ALLOWED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.flatMap(d => d.safeMode === 'allow' ? [d.name] : [])
);

/** Session tool names blocked in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_BLOCKED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.flatMap(d => d.safeMode === 'block' ? [d.name] : [])
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  apiVersion: SessionToolApiVersion;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  exposure: SessionToolExposure;
  executionMode: SessionToolExecutionMode;
  safeMode: SessionToolSafeMode;
  readOnly?: boolean;
}

/**
 * Convert a single session tool definition to JSON Schema format (MCP/Pi shape).
 * Shared by getToolDefsAsJsonSchema and by MCP bridges that expose extra
 * mcp-only tools defined via defineTool.
 */
export function toJsonSchemaToolDef(def: SessionToolDef, prefix = ''): JsonSchemaToolDef {
  // Explicit `as any` avoids TS2589 ("type instantiation is excessively deep")
  // caused by zodToJsonSchema inferring deep generic chains from union schemas.
  const inputSchema = zodToJsonSchema(def.inputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
  const outputEnvelopeSchema = zodToJsonSchema(def.outputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
  const outputProperties = outputEnvelopeSchema.properties as Record<string, unknown> | undefined;
  const structuredContentSchema = outputProperties?.structuredContent;
  // MCP validates outputSchema against structuredContent, not the full ToolResult envelope.
  if (!structuredContentSchema || typeof structuredContentSchema !== 'object' || Array.isArray(structuredContentSchema)) {
    throw new Error(`Session tool '${def.name}' output schema must declare structuredContent`);
  }
  const outputSchema = { ...structuredContentSchema } as Record<string, unknown>;
  // Strip metadata not needed by MCP/Pi consumers
  delete inputSchema.$schema;
  delete inputSchema.additionalProperties;
  delete outputSchema.$schema;
  // MCP Tool input schemas require an object root; Zod unions emit only anyOf.
  inputSchema.type = 'object';
  return {
    name: prefix + def.name,
    apiVersion: def.apiVersion,
    description: def.description,
    inputSchema,
    outputSchema,
    exposure: def.exposure,
    executionMode: def.executionMode,
    safeMode: def.safeMode,
    ...(def.readOnly !== undefined ? { readOnly: def.readOnly } : {}),
  };
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @param opts.prefix - Optional prefix for tool names (e.g., 'mcp__session__' for Pi)
 * @param opts.includeDeveloperFeedback - Include experimental feedback tool in output
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
  includeMemory?: boolean;
  includeWorkspaceObjects?: boolean;
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({
    includeDeveloperFeedback: opts?.includeDeveloperFeedback,
    includeMemory: opts?.includeMemory,
    includeWorkspaceObjects: opts?.includeWorkspaceObjects,
  });

  return defs.map(def => toJsonSchemaToolDef(def, prefix));
}
