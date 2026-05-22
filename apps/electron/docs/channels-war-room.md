# Channels / Hermes War Room

This document is the maintenance contract for Craft channels that behave like Slack-style rooms with agent participants. Read this before changing channel routing, Hermes integration, Kanban delegation, or the conversation panel.

## Product intent

Channels are not just labels or filtered chats. The intended model is:

- A workspace can have named channels, similar to Slack channels.
- A channel has a visible conversation log shared by the user and agent participants.
- Participants can be normal model connections or Hermes profiles.
- Mentions such as `@research` or `@server-ops` route a user message to specific participants.
- Lead/orchestrator modes route an untagged message to a lead Hermes participant that decides what to do.
- Hermes can use Craft-native session tools through ACP/MCP and can delegate work through the Hermes Kanban board.
- Channel lead/orchestrator sessions can use the Craft-native `channel_dispatch`
  session tool to call another configured participant in the same channel,
  including native agents such as Claude/Pi-style connections.
- Worker results return to the same channel so the user sees the outcome in one place.

Do not collapse this back into one private chat session. The channel log is the shared surface; individual agent sessions are implementation details.

## Main files

| Area | Files |
| --- | --- |
| Shared channel types | `packages/shared/src/channels/types.ts` |
| Mention resolution | `packages/shared/src/channels/mentions.ts` |
| Channel CRUD/storage/messages | `packages/shared/src/channels/{crud,storage,messages}.ts` |
| Channel dispatch storage | `packages/shared/src/channels/dispatches.ts` |
| RPC contract | `packages/shared/src/protocol/channels.ts` |
| RPC handlers and Kanban polling | `packages/server-core/src/handlers/rpc/channels.ts` |
| Routing/orchestration packets | `packages/server-core/src/channels/channel-orchestrator.ts` |
| Hermes Kanban SQLite reader | `packages/server-core/src/channels/hermes-kanban.ts` |
| Electron IPC parity | `apps/electron/src/transport/channel-map.ts` |
| Renderer conversation UI | `apps/electron/src/renderer/components/app-shell/ChannelConversationPanel.tsx` |

## Routing contract

Channel routing is defined by `WarRoomRoutingConfig.mode`:

- `manual-tags`: only mentioned participants are targeted. Untagged messages stay in the channel and do not spawn agents.
- `lead`: mentioned participants win; if there are no mentions, send the message to the lead participant.
- `all`: untagged messages target all participants; `@all` is allowed by default.
- `orchestrator`: always send the message to the lead/orchestrator participant. The orchestrator decides whether to delegate.

Lead selection is intentionally forgiving:

1. If `routing.leadParticipantId` is set and matches a participant, use that participant.
2. Otherwise use the first participant whose `llmConnection === 'hermes'`.
3. Otherwise use the first participant.
4. If the channel has no participants, target nobody.

Do **not** reintroduce a hard requirement that `leadParticipantId` must be set for `lead` or `orchestrator` mode. That broke Slack-like use because a user expects an untagged message in a lead room to go somewhere useful.

## Session and message flow

1. Renderer calls channel RPC, usually `channels:SEND_MESSAGE`.
2. `packages/server-core/src/handlers/rpc/channels.ts` appends the user message to the channel message log.
3. The handler calls `ChannelOrchestrator.sendMessage()` with recent channel context.
4. `channel-orchestrator.ts` resolves mentions/routing and creates or reuses one Craft session per `{channelId}:{participantId}`.
5. The hidden packet sent to the agent includes:
   - channel name/description;
   - recent shared channel messages;
   - participant identity;
   - user message;
   - for orchestrators, the worker roster and Kanban operating rules.
6. Assistant replies are appended back as channel messages with `authorType: 'agent'`, `authorId: participantId`, and `sourceSessionId`.
7. The server broadcasts `RPC_NAMESPACES.channels.MESSAGES_CHANGED` so the UI refreshes.

Important: individual sessions do **not** share private history. The channel log is the shared memory. Keep passing recent channel context in orchestration packets.

## Dispatch contract

Each routed channel turn records durable per-participant dispatch state under
workspace-local storage in `channels/dispatches/<channelId>.jsonl`. The latest
record for each dispatch id is reconstructed from the append-only log. This is
not a secrets store and must not contain unrelated global/session auth data.

Dispatch entries use the `WarRoomDispatch` shape:

- `id`
- `channelId`
- `participantId`
- `sourceMessageId`
- optional `parentMessageId`
- optional `sourceSessionId`
- `status`: `queued`, `running`, `completed`, `failed`, or `cancelled`
- optional `error`
- `createdAt`
- `updatedAt`

Dispatch listing must stay channel-scoped. Use the `channels:listDispatches`
RPC to retrieve persisted dispatch status for one channel. Do not read or surface
dispatches from another channel when rendering or debugging one room.

## Hermes / MCP contract

Hermes inside Craft must use the embedded ACP bridge and session-scoped MCP servers. The critical expectation is:

- Craft passes `craft-sources` and `craft-session` MCP endpoints through ACP `session.mcpServers`.
- Hermes must see Craft-native tools such as `mcp__session__browser_tool`, `mcp__session__spawn_session`, `mcp__session__call_llm`, `SubmitPlan`, config tools, and skill tools when available.
- Hermes must see `mcp__session__channel_dispatch` when its Craft session was
  created by channel routing. The tool input is:
  - `participantId`: required channel participant id;
  - `message`: required task/message for that participant;
  - `channelId`: optional, inferred from the current channel-bound session;
  - `parentMessageId`: optional channel message id to link the dispatch to.
- `channel_dispatch` appends a system dispatch marker to the same channel,
  routes the work to the requested participant's Craft session, appends any
  participant reply back into the channel, and returns dispatch id/status. It is
  for same-channel participants only; it must not become a cross-channel or
  global session router.
- Do not make Craft-native tools global by writing them as a static Hermes `mcp.json` default.
- Keep `HERMES_HOME` app-scoped through `normalizeHermesRuntimeConfig().hermesHome` unless a test deliberately overrides it.
- Do not use the user's standalone `~/.hermes` for embedded Craft operation.

When validating a live app, initialize the working `craft-session-tools` MCP endpoint and run `tools/list`; an HTTP 200 on `initialize` alone is not enough.

## Hermes Kanban contract

The War Room path uses Hermes Kanban as the durable delegation state. `channel-orchestrator.ts` tells the Hermes lead to create tasks like:

```bash
HERMES_HOME="<app-scoped-hermes-home>" hermes kanban create "<title>" --assignee <kanbanAssignee> --body "<body>" --json
```

Rules:

- The task title is positional. Do not invent `--title`.
- Use the explicit app-scoped `HERMES_HOME` in prompts/commands so dispatcher and workers read the same board.
- For Hermes participants, the Kanban assignee is `participant.hermesProfile` when set; otherwise it is `participant.id`.
- For non-Hermes participants, the assignee is `participant.id`.
- `packages/server-core/src/channels/hermes-kanban.ts` reads the current board from:
  - `HERMES_KANBAN_DB`, if explicitly set;
  - otherwise `HERMES_KANBAN_HOME`/app `HERMES_HOME`;
  - otherwise the current board marker under `kanban/current`;
  - defaulting to `<HERMES_HOME>/kanban.db`.
- Terminal statuses are `done`, `blocked`, and `archived`.
- `channels.ts` only watches tasks created for the channel's expected assignees. Keep that filter to avoid leaking unrelated Kanban tasks into a channel.

## UI contract

`ChannelConversationPanel.tsx` should make the routing visible enough that a user knows the send did something:

- show a loading/sending state while `SEND_MESSAGE` is in flight;
- append/refresh channel messages after the RPC returns;
- auto-scroll to the latest message;
- make configured participants visible as `@agent` chips in the channel header;
- expose an inline participant editor for the first usable path, so empty channels
  are not stuck behind raw `channels/config.json` edits;
- show mention autocomplete when the composer has an active `@...` token;
- show dispatch feedback: targeted agents, unknown mentions, per-agent failures,
  and recent persisted dispatch status;
- do not hide unknown mentions or failed agent dispatches silently.

This is part of the Slack-like mental model: the user should feel they posted into a room and see who got pinged.

## Things not to break

- Do not treat a channel as only a label. Labels may exist for organization, but channel messages and participants are a separate feature.
- Do not require `leadParticipantId` for a usable lead room.
- Do not route every message to every participant unless the mode is `all`.
- Do not bypass `resolveChannelMentions()` with ad-hoc string parsing.
- Do not remove recent channel context from agent packets.
- Do not store secrets or global auth in channel config/messages.
- Do not couple Hermes channels to Claude/Pi backend internals. Hermes is its own ACP/Python backend.
- Do not silently spawn a system `hermes` from `PATH` for embedded Craft behavior.
- Do not let unrelated Hermes Kanban tasks appear as updates in the wrong channel.

## Validation checklist

Run these from the repo root after changing channels, Hermes routing, Kanban integration, or the panel UI:

```bash
bun test packages/server-core/src/handlers/rpc/channels.test.ts \
  packages/server-core/src/channels/channel-orchestrator.test.ts \
  packages/server-core/src/channels/hermes-kanban.test.ts

bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/transport/__tests__/channel-map-parity.test.ts

cd packages/server-core && bun run typecheck
cd ../../apps/electron && bun run typecheck
cd ../.. && bun run electron:build:renderer

git diff --check
```

Expected coverage:

- channel CRUD and message persistence pass;
- `manual-tags`, `lead`, `all`, and `orchestrator` routing stay covered;
- untagged `lead` messages target the inferred lead;
- Hermes ACP config uses app-scoped `HERMES_HOME`;
- `craft-session-tools` still exposes MCP tools;
- renderer builds with the channel panel changes.

## Live smoke checklist

When Craft is running locally:

1. Confirm the app and ports belong to Craft, not another Electron app:

   ```bash
   ps aux | grep -Ei 'Craft|Electron|Hermes|acp_adapter' | grep -v grep
   lsof -iTCP -sTCP:LISTEN -P -n | grep -E 'Craft|Electron|647|593|5273|9876|9877|9878' || true
   ```

2. Probe candidate `/mcp` ports with a real MCP client and confirm the server named `craft-session-tools` returns `tools/list`.
3. In the UI, create/open a channel with a Hermes participant and `lead` or `orchestrator` routing.
4. Send an untagged message. It should dispatch to the lead/Hermes participant.
5. Send a message with a known mention. It should dispatch only to that participant unless the mode explicitly says otherwise.
6. Send a message with an unknown mention. The UI should surface the unknown mention.
7. If the Hermes lead creates Kanban tasks, verify the tasks land in the app-scoped Hermes Kanban DB and completed/blocked task updates return to the same channel.

Known caveats seen during validation:

- BackgroundComputerUse/window automation may be denied by macOS or the harness. If it says `User denied. Do NOT retry.`, fall back to RPC/test-harness validation and report that visual clicking was not automated.
- `errors.log` may show Python `BrokenPipeError` when MCP sessions close; that alone does not prove channel routing is broken.
- If approval callbacks fail with `allow_permanent` or Pydantic `ToolCallStart` validation errors, inspect the Hermes ACP permission bridge before blaming channel code.
