# Craft Agents OSS - Development Notes

This repo is a Craft fork. Treat Craft upstream sync and Hermes runtime
updates as separate concerns. Hermes is consumed as a pinned upstream
dependency plus Craft overlay patches, not as a hand-merged sibling fork.
For day-to-day/dashboard updates the Hermes pin should be a concrete known-good
tag or SHA so the `(pin + overlay patches)` pair is reproducible. Use floating
refs like `upstream/main` only during an explicit Hermes bump/overlay-refresh
session; after validation, persist the resolved known-good tag/SHA instead of
leaving the dashboard pointed at a moving branch.

## Upstream inputs

- Craft fork:
  - local repo: `craft-agents-oss`
  - `origin`: `https://github.com/guilhermexp/craft-agents-oss.git`
  - `upstream`: `https://github.com/lukilabs/craft-agents-oss.git`
- Hermes upstream consumed by Craft:
  - primary source: pinned `NousResearch/hermes-agent` clone under
    `apps/electron/scripts/.hermes-cache/source` (gitignored, build-owned)
  - pin file: `apps/electron/scripts/hermes-version.txt`
  - Craft overlay patches: `apps/electron/scripts/hermes-patches/*.patch`
  - no user fork is part of the normal flow. Do not use
    `guilhermexp/hermes-agent` or a sibling `../hermes-agent` checkout as an
    implicit source.
  - explicit dev override only: `HERMES_SRC=/path/to/hermes-agent` skips the
    cache and patch overlay for short-lived active Hermes development. It must
    never be the default update/bundle path.

`git fetch upstream --prune` is safe in dirty worktrees. Do not merge,
fast-forward, rebase, reset, or checkout over local changes unless the user
explicitly asks for that operation.

Before any fork sync decision, record:

```bash
git status --short
git fetch upstream --prune
git rev-list --left-right --count HEAD...upstream/main
git log --oneline HEAD..upstream/main -n 20
git log --oneline upstream/main..HEAD -n 20
```

## Hermes embedded runtime

The integration contract is documented in
`apps/electron/docs/hermes-embed.md`. Update that document whenever changing:

- Hermes runtime bundling scripts.
- `packages/shared/src/agent/hermes-agent.ts`.
- `packages/shared/src/hermes/acp-config.ts`.
- `packages/shared/src/mcp/session-tools-server.ts`.
- Hermes overlay patches under `apps/electron/scripts/hermes-patches/`.

Hermes must stay isolated from other Craft agents:

- Claude e Pi sao os unicos membros do runtime nativo de agentes em
  `packages/shared/src/agent/native/`. Mudancas de factory Claude/Pi,
  resolucao de modelo, roteamento de credenciais e Pi computer-use pertencem
  a esse modulo.
- Hermes nao deve ser registrado no runtime nativo. Roteie sessoes Hermes por
  `HermesAgent` + `packages/shared/src/hermes/acp-config.ts` +
  `session.mcpServers`, seguindo o contrato `hermes-embed`.
- Hermes is a separate Python/ACP backend, not the Claude SDK backend and not
  the Pi SDK backend. Do not share runtime assumptions, model fallback logic,
  session state, or tool registry shortcuts across those backends.
- Hermes config/state lives under app-scoped `HERMES_HOME`; it must not read or
  write the user's standalone `~/.hermes` during embedded Craft operation.
- The vendored Python runtime is generated under
  `apps/electron/resources/vendor/hermes/`; packaged builds must fail closed if
  it is missing instead of silently spawning a system `hermes` from `PATH`.
- Do not commit Hermes sessions, logs, generated runtime state, or user
  `HERMES_HOME` data to the repo.
- Do not wire Craft-native session tools through a static Hermes `mcp.json` as
  the primary path. Craft passes session-scoped MCP endpoints through ACP
  `session.mcpServers` so browser/session/delegation tools remain per Craft
  session and do not become global Hermes tools.
- Auth bridging is scoped to the active Hermes subprocess/profile: Craft seeds
  selected OAuth/API-key credentials at spawn and watches app-scoped Codex token
  refreshes. Do not scrape unrelated agent credentials or global auth stores.

Craft-native Hermes tools must keep Craft canonical names:

- `craft-session` tools: `mcp__session__browser_tool`,
  `mcp__session__spawn_session`, `mcp__session__call_llm`, etc.
- `craft-sources` tools: source names such as `mcp__github__search_issues`.
- External/non-Craft MCP servers keep Hermes normal names such as
  `mcp_filesystem_read_file`.

Session tools exposed across native TypeScript adapters and Hermes ACP/MCP are
the `session-tools-mcp` frontier API:

- Register every frontier tool through `defineTool(...)` in
  `packages/session-tools-core/src/tool-defs.ts`.
- Keep existing public tools on `apiVersion: "v1"` and preserve the Hermes
  consumer prefix `mcp__session__<tool>`.
- Any incompatible change to a public tool name, required input, output shape,
  or documented error contract must be introduced as a new major version
  instead of mutating `v1` in place. Deprecate `v1` only after a documented
  migration window.
- Every exposed tool must declare explicit Zod `inputSchema` and `outputSchema`;
  the derived JSON Schema feeds MCP and the runtime validators.
- Run `bun run lint:tool-contracts` after changing session tools, in addition
  to the focused Hermes/Craft tests below.

## Structured workspace objects

The Phase A local-first object contract is tracked by
`openspec/changes/add-structured-workspace-objects/` and the evidence notes in
`docs/denchclaw/`. Preserve these boundaries:

- `packages/shared/src/workspace-objects/` owns the canonical SQLite schema,
  repository, reconstructable read projection, manifest protocol and
  revisioned domain events. SQLite commits first; a manifest is only a derived,
  repairable projection. Publish exactly one post-commit event as `ready` or
  `projection-error`; the latter must keep canonical data visible.
- `packages/session-tools-core` owns the versioned `workspace_objects` frontier
  definition. Claude, Pi, Hermes/session MCP and Desktop RPC must call the same
  shared service; never add raw SQL, renderer-specific tools or secrets to the
  public envelope/manifests.
- `packages/server-core/src/workspace-objects/` owns the refcounted manifest
  watcher. It is one watcher per workspace, debounced per path, ignores SQLite
  sidecars/atomic temporaries, and closes all handles and timers when the last
  client unsubscribes.
- `apps/electron/src/renderer/components/app-shell/content-tabs-state.ts` and
  `content-resolver.ts` own pure tab identity plus the bounded SWR lifecycle.
  File identity includes workspace/session/path; object identity includes
  workspace/object/view. Load and refresh share abort/generation guards, and
  eviction must remove payloads rather than only LRU metadata.
- The existing right sidebar remains the product owner. Structured objects
  extend `SessionInfoPopover`/`AppShell` and reuse current file viewers; do not
  create a parallel panel. U5 extends the same `WorkspaceObjectPreviewPanel`
  with the typed table; U6 routes table, Kanban, calendar, timeline, gallery and
  list through `ObjectViewHost` inside that same preview.
- `packages/shared/src/workspace-objects/view-schema.ts` owns the strict saved
  view v1 contract. `query.ts` is the only evaluator for nested filters, search,
  stable multi-sort, visibility and current relation labels. Both
  `query-object` and the Desktop table call it; do not fork query semantics in
  the renderer or an adapter.
- Table edits submit the full current entry through the existing
  `upsert-entries` action. Invalid drafts never call the mutation. A returned
  revision means the canonical commit exists, but the editor closes only after
  the SWR payload reaches that revision and confirms the canonical value.
- U6 adapters consume only the `WorkspaceObjectQueryResult` produced by the U5
  evaluator and retain stable entry IDs/current relation labels. The adapter
  registry owns no storage and incomplete settings render a configurable empty
  state instead of silently falling back to table. If no compatible field
  exists, the explicit table action changes only the local saved-view config so
  the user can persist that adapter through the existing save flow.
- Object Kanban groups only by a configured canonical select/status field. A
  translated no-group column retains entries with null, absent or unknown
  values. Optional fields persist `null` when that column is targeted; for
  required fields the same recovery column stays visible but is disabled and
  non-droppable. Droppable IDs are structural rather than option values. Pointer
  navigation remains active and keyboard navigation resolves the nearest enabled
  structural column geometrically after excluding the card's source column,
  without requiring the draggable card to be a sortable droppable. A pending
  entry is disabled and guarded by operation ID so
  stale responses cannot cross moves; entries remain independent. A drag keeps
  its optimistic value through a `ready` commit envelope and reconciles against
  the latest payload immediately, including when revalidation arrived before the
  commit result. Rejected envelopes, `projection-error`, transport throws or
  canonical mismatch remove only that entry's optimistic override and expose a
  localized error isolated by entry.

### Structured-object child index

| Subtree | Responsibility |
| --- | --- |
| `packages/shared/src/workspace-objects/` | SQLite authority, typed values, projections, manifests, service and events |
| `packages/session-tools-core/src/handlers/workspace-objects.ts` | Validated generic frontier handler |
| `packages/server-core/src/workspace-objects/` | Refcounted filesystem watcher |
| `packages/server-core/src/handlers/rpc/workspace-objects.ts` | Workspace-scoped Desktop bridge |
| `apps/electron/src/renderer/components/app-shell/content-*.ts` | Tabs, target identity, bounded resolver and SWR |
| `apps/electron/src/renderer/components/right-sidebar/workspace-object*.tsx` | Object list and Phase A read preview inside the existing sidebar |
| `apps/electron/src/renderer/components/workspace-objects/` | U5 query/table editors plus U6 registry, six adapters and Kanban commit lifecycle |
| `docs/denchclaw/` | Pinned upstream evidence, known defects and Craft decisions |

### Structured-object verification matrix

| Layer / path | Required tier | Command |
| --- | --- | --- |
| `packages/shared/src/workspace-objects/**` | integration | `bun test packages/shared/src/workspace-objects/__tests__/*.test.ts` |
| `apps/electron/src/renderer/components/workspace-objects/**` | unit | `bun test apps/electron/src/renderer/components/workspace-objects/__tests__/*.test.ts*` |
| `apps/electron/src/renderer/components/right-sidebar/workspace-object*` | unit | `bun test apps/electron/src/renderer/components/right-sidebar/__tests__/workspace-objects-section.test.ts` |

After changing this contract, run the focused Phase A tests, `typecheck:all`,
`lint:tool-contracts`, `lint:i18n:parity`, strict OpenSpec validation and
`git diff --check`. Real Electron smoke and phase audit remain separate evidence.

When bumping or automatically following the Hermes upstream pin, preserve these
overlay behaviors:

- `acp_adapter/session.py` stores ACP-provided `mcp_servers` on session state.
- `acp_adapter/server.py` passes `stream_callback` into `AIAgent.run_conversation`
  and re-registers MCP toolsets after ACP `session/set_model` and Hermes
  `/model` recreate the underlying agent. Upstream Hermes already handles
  reasoning-delta routing; avoid duplicate local reasoning patches unless the
  upstream contract changes.
- `tools/mcp_tool.py` special-cases Craft MCP naming while preserving normal
  Hermes MCP naming for external servers.
- `hermes_cli/web_server.py` delegates dashboard Update to Craft's host update
  command only when `CRAFT_HERMES_EMBEDDED=1`.
- `plugins/google_meet/tools.py` + `plugins/google_meet/_craft_playwright.py`
  provision the Playwright driver + Chromium on-demand on the first local Google
  Meet join (into app-scoped `$HERMES_HOME/runtime-deps/google-meet`), because
  `bundle-hermes.*` no longer vendors Playwright (only `websockets`). Keep this
  on-demand path: the signed venv must not be mutated, first use downloads with
  progress to stderr, and offline first use must fail with a clear error, not a
  silent crash. See `apps/electron/docs/hermes-embed.md`.

When syncing Craft upstream, preserve these Craft-side integration points:

- `packages/shared/src/agent/hermes-agent.ts` passes both `craft-sources` and
  `craft-session` MCP endpoints to Hermes through ACP.
- `packages/shared/src/hermes/acp-config.ts` keeps bundled Hermes command,
  args, env, and app-scoped `HERMES_HOME` coherent.
- `packages/shared/src/mcp/session-tools-server.ts` keeps browser,
  delegation/session, LLM, auth/config, metadata, and automation tools
  session-scoped.
- `packages/server-core/src/handlers/rpc/hermes.ts` keeps runtime detection,
  dashboard launch, logs/files/skills browsing, dashboard-delegated dev
  update, and update-completion notification path-safe under app-scoped
  `HERMES_HOME`.
- `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx` keeps the
  Hermes operational UI compact, launches the Hermes dashboard, and avoids raw
  giant session/skill dumps. Settings must not duplicate the dashboard's native
  update action.

## Channels / Hermes War Room

The Slack-like War Room channel contract is documented in
`apps/electron/docs/channels-war-room.md`. Update that document whenever
changing:

- shared `WarRoom*` channel types, CRUD, message storage, or mention resolution;
- `packages/server-core/src/channels/channel-orchestrator.ts`;
- `packages/server-core/src/handlers/rpc/channels.ts`;
- `packages/server-core/src/channels/hermes-kanban.ts`;
- `apps/electron/src/renderer/components/app-shell/ChannelConversationPanel.tsx`.

Preserve the product model: War Room channel messages are a shared room
surface, while agent sessions are implementation details. Keep protocol
routing vocabulary as RPC namespaces (`RPC_NAMESPACES`), not product channels.
Do not require `leadParticipantId` for usable `lead`/`orchestrator` rooms;
infer a Hermes lead first, then the first participant. Keep Hermes Kanban using
app-scoped `HERMES_HOME` and profile-slug assignees so worker tasks and War
Room updates stay connected.

## Meetings capture (Hermes google_meet bot)

`apps/electron/src/main/meetings/meeting-service.ts` owns the Hermes capture
lifecycle. Preserve these invariants:

- Every terminal signal — Stop explícito, pane fechado, bot morto detectado pelo
  health check, delete-while-running, quit — passa por `finalizeHermesCapture`,
  que é idempotente por `meetingId`. A ordem é sempre buscar transcript →
  persistir → `pm.stop` confirmado → gravar status/`endReason`; inverter perde o
  transcript, porque `pm.stop` limpa o ponteiro do processo ativo do plugin. O
  único `stop` fora do sink é o rollback de um `start` que falhou (o bot nunca
  entrou no call, nada é purgado, e `pm.start` substitui um bot obsoleto).
- A entrada de `hermesFinalizations` é o mutex do bot singleton, e o sink é o
  único a escrever status terminal. `stop()` e `deleteMeeting()` não anunciam
  término antes do seal: enquanto a finalização está em voo, `start()` recusa a
  reunião seguinte (`meetings.hermesBotBusy`), senão o finalizer anterior mataria
  o bot novo e capturaria o transcript dele. A entrada sai da tabela no settle, e
  o trecho pós-seal (cleanup do delete + rearme) é síncrono, então nenhum sinal
  novo se intercala entre o cleanup e a liberação do mutex.
- Delete-while-running roda `transcript → persist → stop` antes de remover
  record/transcript/summary/artifacts. A intenção de purge mora em
  `pendingDeletions` (que também esconde a reunião da API na hora), não num
  callback: um delete que chega sobre uma finalização já em voo é honrado por
  ela, purgando exatamente uma vez. `settlePendingDeletion` consome a intenção
  sempre — um seal falho devolve a reunião à API em vez de deixá-la oculta — mas
  só purga quando o seal não falhou. Nada pode recriar artefato depois do
  cleanup.
- Falha transitória de seal — persistência, ou um `pm.stop` sem confirmação —
  devolve `failed`: nada terminal é gravado, nada é purgado, a entrada in-flight
  é limpa e `rearmHermesReconciliation` rearma health check + poll para o record
  ainda ativo, então um sinal posterior retenta. `shutdown()` e
  `shutdownMeetingCaptures()` reportam `failed` em vez de `sealed` nesse caso.
- A escrita do store (`persist(state)`) é o ponto de virada de toda mutação de
  record: `updateRecord` e `purgeMeeting` mutam os Maps antes dela e, se ela
  lançar, restauram exatamente o estado anterior antes de relançar. Memória à
  frente do disco é o que quebra o retry — um terminal só em memória faz o
  rearme ignorar um record que o disco ainda vê `running`, e um purge só em
  memória apaga arquivos por um delete que reaparece no próximo boot. As
  escritas derivadas depois do store (summary/transcript) ficam fora do
  rollback: elas não invalidam um store já persistido.
- Evidência do bot é o que autoriza terminal/free/purge, tanto no health check
  quanto no stop: `{ok:false, reason:'no active meeting'}` (o único `ok:false`
  que `pm.status()`/`pm.stop()` produzem) conta como bot ausente e `ok:true`
  conta como sucesso, mas um `ok:false` de exec — timeout, runtime ausente, saída
  não parseável — é transiente e não encerra nada. Ver `classifyHermesBotStatus`
  e `confirmHermesBotStopped`.
- O resumo opcional por agente (`summarizeOnEnd`/`followUpOnEnd`) roda
  fire-and-forget depois do seal, com erro logado: aguardá-lo dentro da janela
  in-flight manteria o bot singleton ocupado e atrasaria shutdown/relaunch com a
  captura já selada.
- O transcript é persistido incrementalmente enquanto a reunião roda
  (`startTranscriptPoll`), com skip-if-unchanged e sem nunca encurtar o que já
  está no disco. Finalizar apenas sela o tail. O poll usa status `ready`, não
  `capturing`: `recoverInterruptedTranscriptions` rebaixa transcripts
  `capturing` sem recording em disco.
- `shutdownMeetingCaptures()` é chamado no `before-quit` de
  `apps/electron/src/main/index.ts` antes de derrubar panes e subprocessos, e é
  bounded por `MEETINGS_SHUTDOWN_DEADLINE_MS`: o quit segue no deadline.
- `app:relaunch` usa `app.relaunch()` + `app.exit(0)`, que não emitem
  `before-quit`, então o handler passa por `relaunchAfterSealingCaptures()` e
  aguarda o mesmo shutdown bounded antes de relançar. Qualquer novo caminho de
  exit que não emita `before-quit` MUST fazer o mesmo.
- `endReason` é interno ao main process nesta fase; expor no DTO/UI é F2.

`packages/shared/src/workspaces/storage.ts` resolve o config root em cada
chamada (`CRAFT_CONFIG_DIR`, com fallback em `homedir()`). Não reintroduza uma
constante de config root capturada no load do módulo para resolver paths: as
suítes de meetings apontam `CRAFT_CONFIG_DIR` para um tmpdir e voltariam a
escrever no `~/.craft-agent` real.

## Validation

For Hermes/Craft integration changes, run the focused Craft tests:

```bash
bun test packages/shared/src/hermes/__tests__/acp-config.test.ts \
  packages/shared/src/hermes/__tests__/auth-bridge.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts \
  packages/shared/src/agent/__tests__/hermes-agent.test.ts \
  packages/server-core/src/handlers/rpc/hermes.test.ts \
  apps/electron/src/main/handlers/__tests__/registration.test.ts
```

For meetings capture/lifecycle or workspace-storage path changes, run:

```bash
bun test apps/electron/src/main/meetings/meeting-service.test.ts \
  apps/electron/src/main/meetings/recording-service.test.ts \
  packages/shared/src/workspaces/__tests__/storage-meetings.test.ts
```

For Hermes overlay changes, first prove all overlays apply from a clean cache
checkout:

```bash
git -C apps/electron/scripts/.hermes-cache/source reset --hard HEAD
for p in apps/electron/scripts/hermes-patches/*.patch; do
  git -C apps/electron/scripts/.hermes-cache/source apply --check "$PWD/$p"
done
```

Then run Python-side tests against the patched Hermes source used for the
bundle. If you are iterating with `HERMES_SRC`, run from that checkout;
otherwise run from `apps/electron/scripts/.hermes-cache/source` after the
patches have been applied by `bundle-hermes.*`:

```bash
uv run --extra dev --extra acp python -m pytest \
  tests/acp/test_server.py -k "mcp" \
  tests/tools/test_mcp_tool.py -k "craft or converts_mcp_tool_to_hermes_schema"
```

When packaging or validating release behavior, rebuild Hermes before the
Electron distribution step:

```bash
cd apps/electron
bun run bundle:hermes
```

## CLAUDE.md / AGENTS.md scope

There is a repo-local `CLAUDE.md`, but `AGENTS.md` remains the source of truth
for Craft fork-sync and Hermes integration contracts. The parent `../CLAUDE.md`
is SelfHosting infra-oriented and contains environment-specific server notes,
so keep Craft/Hermes integration instructions in this repo-local `AGENTS.md`
and `apps/electron/docs/hermes-embed.md`.

<!-- OPENSPEC:START -->
@/openspec/AGENTS.md
<!-- OPENSPEC:END -->
