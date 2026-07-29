# Claude SDK Agent Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded Claude SDK deterministic and surface implicit-team lifecycle through the app's existing background-task chips.

**Architecture:** Keep Claude's native `Agent`/`Workflow` runtime and Craft's `PreToolUse` permission boundary. Normalize team hooks into provider-neutral `AgentEvent` variants, forward them through `SessionManager`, and project them into the existing Jotai background-task model with a pure reducer. No dedicated team store or panel.

**Tech Stack:** TypeScript strict mode, Bun tests, Claude Agent SDK 0.3.219 / Claude Code 2.1.219, Electron RPC events, React, Jotai, i18next.

## Global Constraints

- Preserve legacy `Task` and current `Agent` launcher names.
- Do not add `TeamCreate` or `TeamDelete`; Claude Code 2.1.219 uses one implicit team per session.
- Keep all child tool calls behind Craft's existing `PreToolUse` hook and permission modes.
- Do not change the public `session-tools-mcp` v1 output shape.
- Use `settingSources: ['project', 'local']`; do not load global `~/.claude` settings.
- Reuse `backgroundTasksAtomFamily`, `ActiveTasksBar`, and `TaskActionMenu`.
- Agent stopping remains model-driven through Claude's `TaskStop`; the UI must not pretend it can directly kill a named agent.

---

### Task 1: Deterministic SDK settings and current tool policy

**Files:**
- Modify: `packages/shared/src/agent/options.ts`
- Modify: `packages/shared/src/agent/core/pre-tool-use.ts`
- Modify: `packages/shared/src/agent/mode-manager.ts`
- Modify: `packages/shared/src/agent/claude-agent.ts`
- Create: `packages/shared/src/agent/__tests__/options.test.ts`
- Modify: `packages/shared/src/agent/__tests__/mode-manager-path-boundary.test.ts`
- Modify: `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts`

**Interfaces:**
- Produces: `getDefaultOptions(...).settingSources === ['project', 'local']`.
- Produces: explicit built-in classification for `Agent`, `Workflow`, `SendMessage`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, and `TaskStop`.
- Consumes: existing `Options`, `stripToolMetadata`, and `shouldAllowToolInMode` APIs.

- [ ] **Step 1: Write failing SDK-settings and tool-policy tests**

```ts
// packages/shared/src/agent/__tests__/options.test.ts
import { describe, expect, it } from 'bun:test'
import { getDefaultOptions } from '../options.ts'

describe('getDefaultOptions', () => {
  it('loads only project and local Claude settings', () => {
    expect(getDefaultOptions({}).settingSources).toEqual(['project', 'local'])
  })
})
```

Add behavioral assertions to the existing permission tests:

```ts
for (const toolName of [
  'Agent', 'Workflow', 'SendMessage',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop',
]) {
  expect(shouldAllowToolInMode(toolName, {}, 'safe').allowed).toBe(true)
}
```

Add a metadata-preservation assertion:

```ts
const input = { _intent: 'delegate review', prompt: 'Review the code' }
expect(stripToolMetadata('Agent', input)).toEqual({ modified: false, input })
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
bun test packages/shared/src/agent/__tests__/options.test.ts \
  packages/shared/src/agent/__tests__/mode-manager-path-boundary.test.ts \
  packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts
```

Expected: the settings-source assertion fails because `settingSources` is absent; at least `Agent` metadata classification is not explicit.

- [ ] **Step 3: Implement explicit settings and tool registries**

In `getDefaultOptions`, include the same constant in every return path:

```ts
const EMBEDDED_CLAUDE_SETTING_SOURCES = ['project', 'local'] as const

const baseOptions = {
  env,
  settingSources: [...EMBEDDED_CLAUDE_SETTING_SOURCES],
} satisfies Partial<Options>
```

Return `{ ...baseOptions, pathToClaudeCodeExecutable }` for explicit binary paths and `baseOptions` for auto-discovery.

Extend `BUILT_IN_TOOLS` and `ALWAYS_ALLOWED_TOOLS` with the current orchestration names. Keep `Task` for backward compatibility. Do not classify `TeamCreate`/`TeamDelete`.

Replace the stale `claude-agent.ts` comment above `disallowedTools` with:

```ts
// Native plan mode and the SDK Skill tool are replaced by Craft-owned flows.
// The rest of the Claude Code preset, including file and orchestration tools,
// remains available and is governed by Craft's PreToolUse dispatcher.
```

- [ ] **Step 4: Run the focused tests and confirm pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the policy change**

```bash
git add packages/shared/src/agent/options.ts \
  packages/shared/src/agent/core/pre-tool-use.ts \
  packages/shared/src/agent/mode-manager.ts \
  packages/shared/src/agent/claude-agent.ts \
  packages/shared/src/agent/__tests__/options.test.ts \
  packages/shared/src/agent/__tests__/mode-manager-path-boundary.test.ts \
  packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts
git commit -m "fix(claude): isolate settings and classify team tools"
```

---

### Task 2: Normalize Claude implicit-team hooks

**Files:**
- Create: `packages/shared/src/agent/backend/claude/team-lifecycle.ts`
- Create: `packages/shared/src/agent/backend/claude/team-lifecycle.test.ts`
- Modify: `packages/core/src/types/message.ts`
- Modify: `packages/shared/src/agent/claude-agent.ts`
- Modify: `packages/shared/src/agent/tool-matching.ts`
- Modify: `packages/shared/src/agent/__tests__/tool-matching.test.ts`

**Interfaces:**
- Produces: `normalizeClaudeTeamLifecycleHook(input): AgentEvent | null`.
- Produces new `AgentEvent` variants `team_task_created`, `team_task_completed`, and `teammate_idle`.
- Extends `task_backgrounded` with optional `agentName`.
- Consumes SDK hook fields exactly as declared by 0.3.219: `task_id`, `task_subject`, `task_description`, `teammate_name`.

- [ ] **Step 1: Write failing normalizer tests**

```ts
import { describe, expect, it } from 'bun:test'
import { normalizeClaudeTeamLifecycleHook } from './team-lifecycle.ts'

describe('normalizeClaudeTeamLifecycleHook', () => {
  it('normalizes TaskCreated', () => {
    expect(normalizeClaudeTeamLifecycleHook({
      hook_event_name: 'TaskCreated',
      task_id: 'task-1',
      task_subject: 'Review auth',
      task_description: 'Check token refresh',
      teammate_name: 'reviewer',
    })).toEqual({
      type: 'team_task_created',
      taskId: 'task-1',
      subject: 'Review auth',
      description: 'Check token refresh',
      teammateName: 'reviewer',
    })
  })

  it('normalizes TaskCompleted', () => {
    expect(normalizeClaudeTeamLifecycleHook({
      hook_event_name: 'TaskCompleted',
      task_id: 'task-1',
      task_subject: 'Review auth',
      teammate_name: 'reviewer',
    })).toEqual({
      type: 'team_task_completed',
      taskId: 'task-1',
      subject: 'Review auth',
      teammateName: 'reviewer',
    })
  })

  it('normalizes TeammateIdle and rejects blank identifiers', () => {
    expect(normalizeClaudeTeamLifecycleHook({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'reviewer',
    })).toEqual({ type: 'teammate_idle', teammateName: 'reviewer' })
    expect(normalizeClaudeTeamLifecycleHook({
      hook_event_name: 'TaskCreated',
      task_id: '',
      task_subject: 'Invalid',
    })).toBeNull()
  })
})
```

Add a tool-matching assertion that an async named `Agent` launch emits `agentName: 'reviewer'` on `task_backgrounded`.

- [ ] **Step 2: Run tests and confirm failure**

```bash
bun test packages/shared/src/agent/backend/claude/team-lifecycle.test.ts \
  packages/shared/src/agent/__tests__/tool-matching.test.ts
```

Expected: the normalizer module is missing and `task_backgrounded` lacks `agentName`.

- [ ] **Step 3: Add provider-neutral events and normalizer**

Add these union members to `AgentEvent`:

```ts
| { type: 'task_backgrounded'; toolUseId: string; taskId: string; intent?: string; agentName?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
| { type: 'team_task_created'; taskId: string; subject: string; description?: string; teammateName?: string }
| { type: 'team_task_completed'; taskId: string; subject: string; teammateName?: string }
| { type: 'teammate_idle'; teammateName: string }
```

Implement the normalizer with trimmed required fields and no use of deprecated `team_name`. In `claude-agent.ts`, register `TaskCreated`, `TaskCompleted`, and `TeammateIdle` hooks. Each hook calls the normalizer, logs malformed events, and forwards valid events through `this.onBackgroundEvent?.(event)` before returning `{ continue: true }`.

In `tool-matching.ts`, when a background `Agent`/`Task` result is detected, copy a non-empty `entry.input.name` into `agentName`.

- [ ] **Step 4: Run tests and confirm pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit hook normalization**

```bash
git add packages/core/src/types/message.ts \
  packages/shared/src/agent/backend/claude/team-lifecycle.ts \
  packages/shared/src/agent/backend/claude/team-lifecycle.test.ts \
  packages/shared/src/agent/claude-agent.ts \
  packages/shared/src/agent/tool-matching.ts \
  packages/shared/src/agent/__tests__/tool-matching.test.ts
git commit -m "feat(claude): normalize implicit team lifecycle"
```

---

### Task 3: Track and transport team lifecycle through SessionManager

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts`
- Modify: `packages/server-core/src/sessions/session-event-publisher.ts`
- Modify: `packages/server-core/src/sessions/SessionManager.ts`
- Create: `packages/server-core/src/sessions/claude-team-lifecycle.test.ts`
- Modify: `packages/server-core/src/sessions/session-event-publisher.test.ts`

**Interfaces:**
- Consumes: `team_task_created`, `team_task_completed`, `teammate_idle`, and optional `task_backgrounded.agentName`.
- Produces matching `SessionEvent` variants with `sessionId` added by `SessionEventPublisher`.
- Keeps `list_background_tasks` v1 unchanged by stripping internal `kind`, `agentName`, and `isIdle` fields in its existing mapper.

- [ ] **Step 1: Write failing SessionManager and publisher tests**

Use the existing `createManagedSession`/`dispatchAgentEvent` harness and assert:

```ts
await fire(sessionId, {
  type: 'task_backgrounded',
  toolUseId: 'tool-agent',
  taskId: 'agent-1',
  intent: 'Review auth',
  agentName: 'reviewer',
})
await fire(sessionId, { type: 'teammate_idle', teammateName: 'reviewer' })

expect(sm.listBackgroundTasks(sessionId)).toEqual(expect.arrayContaining([
  expect.objectContaining({ taskId: 'agent-1', agentName: 'reviewer', isIdle: true }),
]))

await fire(sessionId, {
  type: 'team_task_created',
  taskId: 'task-1',
  subject: 'Review auth',
  teammateName: 'reviewer',
})
await fire(sessionId, {
  type: 'team_task_completed',
  taskId: 'task-1',
  subject: 'Review auth',
  teammateName: 'reviewer',
})

expect(sm.listBackgroundTasks(sessionId)).toEqual(expect.arrayContaining([
  expect.objectContaining({ taskId: 'task-1', kind: 'team-task', status: 'completed' }),
]))
```

Extend publisher tests to assert all three events are forwarded verbatim with `sessionId`.

- [ ] **Step 2: Run tests and confirm failure**

```bash
bun test packages/server-core/src/sessions/claude-team-lifecycle.test.ts \
  packages/server-core/src/sessions/session-event-publisher.test.ts
```

Expected: new event variants are not accepted or forwarded.

- [ ] **Step 3: Implement registry and transport handling**

Extend internal `RunningBackgroundTask` only:

```ts
kind?: 'workflow' | 'team-task'
agentName?: string
isIdle?: boolean
```

On `task_backgrounded`, store `agentName` and `kind: 'workflow'` when present. On `teammate_idle`, mark the matching named agent `isIdle = true` and forward the event. On `team_task_created`, upsert a running registry entry whose intent is `description ?? subject`, `kind` is `team-task`, and `agentName` is `teammateName`. On `team_task_completed`, mark the matching entry completed with `completedAt = Date.now()`; create a terminal entry if the create hook was missed. Forward both events.

Add the new variants to `SessionEvent` and `ForwardedAgentEvent`. Do not alter the mapper at `SessionManager.ts:4397-4413`; it already projects only the v1 fields.

- [ ] **Step 4: Run tests and confirm pass**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit server lifecycle support**

```bash
git add packages/shared/src/protocol/dto.ts \
  packages/server-core/src/sessions/session-event-publisher.ts \
  packages/server-core/src/sessions/SessionManager.ts \
  packages/server-core/src/sessions/claude-team-lifecycle.test.ts \
  packages/server-core/src/sessions/session-event-publisher.test.ts
git commit -m "feat(sessions): track Claude team tasks"
```

---

### Task 4: Project team and workflow events into existing chips

**Files:**
- Create: `apps/electron/src/renderer/lib/background-task-events.ts`
- Create: `apps/electron/src/renderer/lib/__tests__/background-task-events.test.ts`
- Modify: `apps/electron/src/renderer/App.tsx`
- Modify: `apps/electron/src/renderer/atoms/sessions.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/TaskActionMenu.tsx`
- Modify: `apps/electron/src/renderer/lib/background-task-retention.ts`
- Modify: `apps/electron/src/renderer/lib/__tests__/background-task-retention.test.ts`
- Modify: `packages/shared/src/i18n/locales/de.json`
- Modify: `packages/shared/src/i18n/locales/en.json`
- Modify: `packages/shared/src/i18n/locales/es.json`
- Modify: `packages/shared/src/i18n/locales/hu.json`
- Modify: `packages/shared/src/i18n/locales/ja.json`
- Modify: `packages/shared/src/i18n/locales/pl.json`
- Modify: `packages/shared/src/i18n/locales/pt-BR.json`
- Modify: `packages/shared/src/i18n/locales/zh-Hans.json`

**Interfaces:**
- Produces: `reduceBackgroundTasks(tasks, event, now): BackgroundTask[]`.
- Extends `BackgroundTask.type` to `'agent' | 'shell' | 'workflow' | 'team-task'` and adds optional `agentName`/`isIdle`.
- Consumes the exact `SessionEvent` team variants from Task 3.

- [ ] **Step 1: Write failing reducer and retention tests**

```ts
expect(reduceBackgroundTasks([], {
  type: 'task_backgrounded',
  sessionId: 's',
  taskId: 'wf-task',
  toolUseId: 'tool-wf',
  kind: 'workflow',
  workflowId: 'wf-1',
}, 100)).toEqual([
  expect.objectContaining({ id: 'wf-task', type: 'workflow', workflowId: 'wf-1' }),
])

expect(reduceBackgroundTasks([], {
  type: 'team_task_created',
  sessionId: 's',
  taskId: 'task-1',
  subject: 'Review auth',
  teammateName: 'reviewer',
}, 100)).toEqual([
  expect.objectContaining({ id: 'task-1', type: 'team-task', agentName: 'reviewer' }),
])

const completed = reduceBackgroundTasks(created, {
  type: 'team_task_completed',
  sessionId: 's',
  taskId: 'task-1',
  subject: 'Review auth',
  teammateName: 'reviewer',
}, 200)
expect(completed[0]).toMatchObject({ status: 'completed', completedAt: 200 })

const idle = reduceBackgroundTasks(agentTasks, {
  type: 'teammate_idle',
  sessionId: 's',
  teammateName: 'reviewer',
}, 300)
expect(idle[0]?.isIdle).toBe(true)
```

Also assert `workflow_agent_completed` increments `agentsCompleted`, and terminal chips remain until the existing retention deadline rather than disappearing immediately.

- [ ] **Step 2: Run tests and confirm failure**

```bash
bun test apps/electron/src/renderer/lib/__tests__/background-task-events.test.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-retention.test.ts
```

Expected: reducer module and `team-task` type do not exist.

- [ ] **Step 3: Implement the pure reducer and wire App.tsx**

Implement `reduceBackgroundTasks` as a total switch over relevant events:

- `task_backgrounded`: upsert `agent` or `workflow` based on `kind`, retaining `agentName` and `workflowId`.
- `workflow_agent_completed`: increment the matching workflow's `agentsCompleted`.
- `team_task_created`: upsert a running `team-task` chip.
- `team_task_completed`: mark the matching chip completed and timestamp it.
- `teammate_idle`: set `isIdle` on the matching named agent chip.
- `tool_start` for `SendMessage`: clear `isIdle` for the recipient in `toolInput.to`.
- `task_progress`: update elapsed time.
- `task_completed` and `shell_killed`: mark terminal and timestamp; do not remove immediately.
- non-background `tool_result`: retain the existing foreground cleanup behavior.

Replace `App.tsx`'s branch-heavy helper body with one atom read plus `reduceBackgroundTasks`; only call `store.set` when the returned array identity changes.

- [ ] **Step 4: Render accurate chip states and translations**

Update `TaskActionMenu` to map types explicitly:

```ts
const typeLabelKey = {
  agent: 'chat.taskTypeAgent',
  workflow: 'chat.taskTypeWorkflow',
  'team-task': 'chat.taskTypeTeamTask',
  shell: 'chat.taskTypeShell',
} satisfies Record<BackgroundTask['type'], string>
```

Show the spinner only for `status === 'running' && !isIdle`. Render the teammate name when present and use the task intent before the shortened ID when space permits. Keep Stop Task visible only for shells because there is no host-level SDK API for stopping a specific teammate.

Add `chat.taskTypeTeamTask` to all eight locale files. Use concise native translations; preserve alphabetical/key ordering used by each JSON file.

- [ ] **Step 5: Run renderer tests and type diagnostics**

```bash
bun test apps/electron/src/renderer/lib/__tests__/background-task-events.test.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-retention.test.ts \
  packages/server-core/src/sessions/workflow-task-progress.test.ts
bun run typecheck
```

Expected: tests pass and typecheck reports no errors.

- [ ] **Step 6: Run the complete focused multiagent suite**

```bash
bun test packages/shared/src/agent/__tests__/options.test.ts \
  packages/shared/src/agent/__tests__/tool-matching.test.ts \
  packages/shared/src/agent/__tests__/claude-event-adapter.test.ts \
  packages/shared/src/agent/__tests__/tool-matching-sdk-fixtures.test.ts \
  packages/shared/src/agent/backend/claude/team-lifecycle.test.ts \
  packages/shared/src/agent/backend/claude/persistent-input.test.ts \
  packages/server-core/src/sessions/claude-team-lifecycle.test.ts \
  packages/server-core/src/sessions/background-task-surface.test.ts \
  packages/server-core/src/sessions/workflow-task-progress.test.ts \
  packages/server-core/src/sessions/session-event-publisher.test.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-events.test.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-retention.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Smoke-test the UI**

Launch the Electron development app, inject representative `task_backgrounded`, `workflow_agent_completed`, `team_task_created`, `teammate_idle`, and completion events through the existing renderer event path, and verify:

- agent, workflow, team-task, and shell labels are distinct;
- workflow completion count increments;
- idle teammates stop spinning;
- terminal chips linger briefly and then disappear;
- shell Stop Task remains available and team/agent chips do not offer a fake stop action.

- [ ] **Step 8: Commit renderer integration**

```bash
git add apps/electron/src/renderer/lib/background-task-events.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-events.test.ts \
  apps/electron/src/renderer/App.tsx \
  apps/electron/src/renderer/atoms/sessions.ts \
  apps/electron/src/renderer/components/app-shell/TaskActionMenu.tsx \
  apps/electron/src/renderer/lib/background-task-retention.ts \
  apps/electron/src/renderer/lib/__tests__/background-task-retention.test.ts \
  packages/shared/src/i18n/locales/*.json
git commit -m "feat(ui): surface Claude team lifecycle in task chips"
```
