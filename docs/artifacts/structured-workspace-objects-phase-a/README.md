# Phase A Electron smoke evidence

Date: 2026-08-01  
Validated commit: `5ce24920`  
Runtime: locally built Electron app, isolated from the operator's real Craft data

## Isolation and fixtures

- Runtime root: `/tmp/craft-phase-a-smoke.ZGD344`
- Electron user data: `/tmp/craft-phase-a-smoke.ZGD344/electron-user-data`
- Phase A workspace: `2ddce2e4-c280-6c4d-0a08-99b707766ca1`
- Control workspace: `1996f2a9-4f16-cad8-d7ef-fd1c546f83e4`
- Object: `object_people`
- Initial projection: revision 2, row `Ana / Lead`
- Updated projection: revision 3, row `Ana / Active`

The smoke used the packaged workspace-object service and the built Electron UI.
The update produced the event preserved in [`smoke-evidence.json`](./smoke-evidence.json).
No files under the operator's real `~/.craft-agent` were read or modified.

## Observable assertions

1. [`04-object-sidebar.png`](./04-object-sidebar.png) shows the object in the
   session sidebar at revision 2.
2. [`05-preview-revision-2.png`](./05-preview-revision-2.png) shows the initial
   object preview with `Ana / Lead`.
3. [`06-preview-revision-3-live.png`](./06-preview-revision-3-live.png) shows the
   same open preview refreshed to revision 3 with `Ana / Active`, without a UI
   reload.
4. [`07-control-workspace-no-leak.png`](./07-control-workspace-no-leak.png)
   shows the control workspace after switching away; the Phase A object and
   session are absent.
5. [`08-returned-preview-restored.png`](./08-returned-preview-restored.png)
   shows the scoped tab restored after returning to the Phase A workspace, with
   revision 3 still current.
6. [`mcp-transcript.log`](./mcp-transcript.log) preserves the standard MCP SDK
   `define-object` → `upsert-entries` → `get-object` requests and successful
   responses for `object_agent_audit` revisions 1 and 2.
7. [`09-agent-mcp-live.png`](./09-agent-mcp-live.png) shows that object in the
   live Electron sidebar and preview as `MCP Agent / Updated` at revision 2.
8. [`electron-teardown.log`](./electron-teardown.log) preserves the window-close,
   RPC disconnect and final no-process/no-CDP postconditions.

The Electron window was then closed. The tracked runtime output records both the
workspace window closing and the WebSocket RPC client disconnecting. The
remaining app process and CDP endpoint were explicitly terminated and checked
absent, covering the subscription-disconnect boundary without leaving a watcher
process alive.

Screenshots `01` through `03` retain the setup path (isolated onboarding,
workspace load and real session creation) so the result is auditable from a
fresh Electron profile rather than only from the final state.
