# Claude SDK Agent Teams Integration Design

## Decision

Integrate Claude Code's implicit-team lifecycle into the existing background-task chips. Do not add a dedicated team panel or the deprecated `TeamCreate`/`TeamDelete` lifecycle.

## SDK configuration

Set `settingSources: ['project', 'local']` explicitly for the embedded Claude runtime. This preserves project and local `CLAUDE.md`/Claude settings while preventing unrelated global `~/.claude` agents, hooks, and plugins from entering Craft sessions. Craft remains responsible for authentication, skills, hooks, permissions, and MCP sources.

## Tool policy

Recognize the current Claude Code orchestration tools explicitly: `Agent`, `Workflow`, `SendMessage`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, and `TaskStop`, while preserving the legacy `Task` name. Team coordination tools are safe in Explore mode because child tool calls still inherit the parent permission mode and pass through Craft's `PreToolUse` hook.

Remove stale comments claiming file tools are disabled; the runtime only disallows native plan-mode tools and `Skill`.

## Lifecycle and UI

Named/background `Agent` launches continue through the existing `task_backgrounded` path. Normalize `TaskCreated`, `TaskCompleted`, and `TeammateIdle` hooks into Craft agent events. Shared team tasks appear in `backgroundTasksAtomFamily` as `team-task` chips. Completion and idle signals update existing chips rather than creating a second state store.

Add `team-task` to the existing `BackgroundTask` model and render distinct labels for agent, workflow, team task, and shell. Fix the current workflow label fallback, which renders workflows as shell tasks. Reuse the current terminal-state retention policy.

Stopping a specific background agent remains model-driven through Claude's `TaskStop`; SDK 0.3.219 exposes no host API for the renderer to invoke it directly. The UI must not offer a fake stop action for agent or team-task chips. Shared coordination tasks are status-only and do not add a new stop protocol.

## Error handling and compatibility

Ignore lifecycle events missing required identifiers and emit debug diagnostics. Never create uncorrelated chips. Preserve both `Task` and `Agent` launcher names. The SDK's current single implicit team is the only supported team model.

## Verification

Cover explicit settings sources, current tool classification, hook normalization, SessionManager forwarding, renderer projection, and task-label rendering with focused tests. Run the existing subagent, workflow, persistent-input, and background-task suites, then smoke-test the renderer projection with representative SDK events.
