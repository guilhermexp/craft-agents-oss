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
  eviction must remove payloads rather than only LRU metadata. Retargeting an
  unpinned preview across scopes replaces only the disposable preview already
  in the destination scope. If the active tab is the source preview or the
  discarded destination preview, active selection follows the new target;
  pinned/permanent tabs and any other surviving active tab keep their current
  semantics.
- The existing right sidebar remains the product owner. Structured objects
  extend `SessionInfoPopover`/`AppShell` and reuse current file viewers; do not
  create a parallel panel. U5 extends the same `WorkspaceObjectPreviewPanel`
  with the typed table; U6 routes table, Kanban, calendar, timeline, gallery and
  list through `ObjectViewHost` inside that same preview.
- `packages/shared/src/workspace-objects/view-schema.ts` owns the strict saved
  view v1 contract. `query.ts` is the only evaluator for nested filters, search,
  stable multi-sort, visibility and current relation labels, including the
  ordered field selector used by bounded relation-option SQL reads. Storage may
  materialize at most 200 fields and 400 candidate IDs in the same snapshot but
  must not duplicate the label-selection rule or introduce N+1 reads. Both
  `query-object` and the Desktop table call it; do not fork query semantics in
  the renderer or an adapter. Relation filters compare both stable IDs and
  current labels (positive operators use OR; negated operators use AND).
  Migration v3 acquires its writer transaction before reading and normalizing
  legacy saved views so it cannot overwrite a concurrent canonical update. A
  normalized legacy config must fit the 64,000-byte UTF-8 limit after JSON
  escaping and the full config wrapper so the migrated view can be resaved.
  Migration v4 rechecks strict v1 rows that v3 previously accepted without a
  byte-budget check: rows already within budget remain unchanged, while an
  oversized strict row preserves adapter, filter, sort, visibility and all
  other settings while shortening only string `legacyConfig`; if the remaining
  strict config cannot fit, fail the migration atomically instead of applying a
  legacy/table fallback. Persist and project the bounded row before v4 is marked.
  `query-object` evaluates the complete canonical
  snapshot before bounding its response to 200 entries and reports
  `totalEntries` plus `truncated`; serialized relation labels are limited to
  IDs referenced by those returned entries. Projection repair is best-effort
  before the read snapshot, whose fallback rebuild remains read-only when the
  writer lock is busy or locked. Classify both Bun `SQLITE_BUSY`/`SQLITE_LOCKED`
  codes and `node:sqlite` `ERR_SQLITE_ERROR` numeric `errcode` primary values
  5/6 as contention; every other SQLite error must still propagate.
- Table edits submit the full current entry through the existing
  `upsert-entries` action. Invalid drafts never call the mutation. A returned
  revision means the canonical commit exists, but the editor closes only after
  the SWR payload reaches that revision and confirms the canonical value. Busy
  field edits use `chat.workspaceObjectSavingField`, not the saved-view label.
  German and Hungarian action prompts added by U5/U6 use the formal register
  consistently (`Sie` forms in German and polite third-person imperatives in
  Hungarian).
  Relation option failures use stable codes (`invalid-response`,
  `stale-snapshot`, `changed-while-loading`, `transport`); render translated
  primary copy and expose only optional transport detail as secondary text.
  Model this as a discriminated union: non-transport variants must not carry a
  `detail` property, and the renderer must guard detail on `code === 'transport'`.
- U6 adapters consume only the `WorkspaceObjectQueryResult` produced by the U5
  evaluator and retain stable entry IDs/current relation labels. The adapter
  registry owns no storage and incomplete settings render a configurable empty
  state instead of silently falling back to table. If no compatible field
  exists, the explicit table action changes only the local saved-view config so
  the user can persist that adapter through the existing save flow.
- Electron renderer imports of workspace-object modules are public package
  boundaries. Keep `query`, `service`, `types` and `view-schema` explicitly
  exported by `packages/shared/package.json`; the consumer-side package export
  test must pass in addition to TypeScript checks before a renderer build.
- Phase C Composio discovery remains metadata-only. Catalog pages normalize and
  deduplicate the stable provider identity in
  `packages/shared/src/sources/composio-catalog.ts`; materialization allowlists
  portable MCP metadata and reuses an existing local source for that identity.
  Tokens, credentials, provider secrets, authorization headers and
  credential-bearing URLs must never enter the source input or persisted
  config. Desktop `SOURCES_GET` must return the explicit allowlisted DTO from
  `public-source-dto.ts`, including a sanitized `connectionError`, rather than a
  raw `LoadedSource`.
- U7 readiness applies only to sources carrying `expectedTools`. Each expected
  tool uses the source-local canonical MCP name plus `apiVersion`; compatibility
  is an exact version match. A newly materialized Composio source starts
  disabled/unhealthy. `source_test` must pass before a temporary injection into
  the current compatible session, and the shared MCP pool must observe every
  expected pair after that injection. Claude, Codex/Pi and Hermes use this same
  pool-derived toolset. Missing tools, version mismatch, unsupported backend,
  injection/observation/cleanup failure or health-persistence failure keeps the
  source disabled/unhealthy and restores the prior session source set. Legacy
  sources without `expectedTools` retain their existing activation behavior.
  Persisted/public health and logs may contain only allowlisted status, stable
  reason codes and portable expected-tool identities; never caught error text,
  credentials, tokens, provider secrets or authorization headers.
- Object Kanban groups only by a configured canonical select/status field. A
  translated no-group column retains entries with null, absent or unknown
  values. Optional fields persist `null` when that column is targeted; for
  required fields the same recovery column stays visible but is disabled and
  non-droppable. Droppable IDs are structural rather than option values. Pointer
  navigation remains active and keyboard navigation resolves the nearest enabled
  structural column geometrically after excluding the current valid `over`
  column, falling back to the card's source only during initial activation. It
  does not require the draggable card to be a sortable droppable. A pending entry
  is disabled and guarded by operation ID so
  stale responses cannot cross moves; entries remain independent. A drag keeps
  its optimistic value through a `ready` commit envelope and reconciles against
  the latest payload immediately, including when revalidation arrived before the
  commit result. Rejected envelopes, transport throws or canonical mismatch
  remove only that entry's optimistic override and expose a localized error
  isolated by entry. A canonical commit envelope with `projection-error` stays
  awaiting revalidation and exposes a separate repair warning until a `ready`
  payload at the committed revision is observed; it never reports rollback.
  Retrying the entry and receiving either a rollback or `ready` commit envelope
  does not clear an earlier warning before revalidation. A later
  `projection-error` replaces it with the newer revision.

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
| `packages/shared/package.json` workspace-object exports | integration | `bun test apps/electron/src/shared/workspace-objects-package-exports.test.ts` |
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
- `endReason` é interno ao main process: nada no DTO/UI depende dele. O estado
  de falha que a UI mostra é a fase de pós-processamento abaixo, não o
  `endReason`.
- O idioma de STT e de toda saída de LLM da reunião vem da preferência
  persistida (`getPersistedUiLanguage`), via
  `apps/electron/src/main/meetings/output-language.ts` —
  `getTranscriptionLanguage()` para o Deepgram e `getOutputLanguageName()` para
  resumo/análise visual. Não volte a ler `i18n.resolvedLanguage`: o i18n do main
  hidrata tarde (#885) e transcreveu áudio PT como fonética inglesa. Sem
  preferência, ambos devolvem `null` — Deepgram detecta o idioma e os prompts
  pedem o idioma da transcrição; forçar `en` (ou `pt-BR`) é o bug.
  `apps/electron/src/main/i18n-bootstrap.ts` mantém o i18n do main coerente com
  o disco (menu nativo, dialogs), mas não é a fonte para meetings.
- A gravação craft tem uma fase de pós-processamento própria
  (`MeetingRecord.postProcessingPhase`), separada do `status` — que continua
  `stopped` ao selar. `completeRecording` abre em `preparing`,
  `transcribeRecording` escreve `transcribing` e `generateAgentVideoAnalysis` é
  a última etapa: ela escreve `analyzing` e resolve em `completed` ou `failed`.
  Toda gravação craft resolve: `failed` é absorvente (a análise roda mesmo
  depois de uma transcrição que falhou e não pode apagar o erro com um
  `completed`), só quem recomeça o pipeline usa `{ restart: true }`, e
  `sanitizeRecord` rebaixa para `failed` qualquer fase em curso lida do disco —
  o pipeline é in-process, então uma fase em voo no store perdeu quem a
  conduzia. Sem isso a UI mostra "Finalizada" durante os minutos de remux,
  Deepgram e análise visual, e progresso eterno depois de um crash.
  `meetingStatusLabelKey` e `isMeetingPostProcessingRunning`
  (`apps/electron/src/renderer/lib/meeting-status-label.ts`) são a única fonte
  do rótulo e do critério de poll da lista e da página; captura Hermes não tem
  fase.
- A prévia da gravação existe desde o primeiro byte, porque
  `attachRecordingTarget` já referencia o `.webm` no record. O que faltava era
  recarregar: selar e remuxar reescrevem o arquivo no MESMO path
  (`renameSync`), então `getRecordingMediaUrl`
  (`apps/electron/src/renderer/lib/meeting-recording-preview.ts`) versiona a URL
  por `partial`/`bytesWritten`/`remuxedAt` e o remux MUST gravar `remuxedAt`
  mesmo quando o tamanho não muda. Uma URL derivada só do path mantém `key` e
  `src` iguais nos três estados e deixa o `<video>` preso à mídia sem Duration
  nem Cues que carregou durante a gravação — duração infinita e nenhum seek.
- A call do Meet encaixada na página de Reuniões é um *frame com buraco*: o
  React desenha a moldura e as `WebContentsView` nativas pintam por cima do
  retângulo medido. A mecânica (medição, dedupe de rects, dock, ocultação sob
  overlays) mora em `apps/electron/src/renderer/hooks/embedded-browser-view.ts`
  + `useEmbeddedBrowserView.ts` e é COMPARTILHADA com o preview do chat
  (`BrowserTabContent`) — não reimplemente. Os dois hosts diferem só no release:
  a aba de preview usa `'conceal'`, porque dock segue a existência da aba e não
  qual aba está ativa; a página usa `'floating'`, porque ela é dona do dock e
  sair da página MUST devolver a janela — instância integrada sem host é janela
  órfã. O buraco não pode ficar dentro do scroller da página: ele é irmão dele
  no flex do `Panel`, senão a superfície rola e as views nativas ficam para trás.
- Para onde um pedido de dock vai é decisão de `resolveBrowserDockRoute`
  (`apps/electron/src/renderer/components/app-shell/browser-dock-routing.ts`),
  consultado pelo relay em `AppShell`: a página de Reuniões vence enquanto está
  aberta, o preview session-scoped atende fora dela, e sem nenhum dos dois o
  browser continua janela. O preview do chat NÃO virou global (D-06); o id da
  instância hospedada viaja por `meetingsHostedBrowserIdAtom`. Perguntar ao
  agente sobre a call hospedada reusa o `MeetingAskButton` — não crie uma
  segunda superfície. Com a reunião ao vivo ele MUST rebuscar a transcrição a
  cada abertura (ela cresce) e marcar `live` no contexto
  (`meeting-ask-context.ts`), senão o agente lê silêncio como "não foi dito".

`packages/shared/src/workspaces/storage.ts` resolve o config root em cada
chamada (`CRAFT_CONFIG_DIR`, com fallback em `homedir()`). Não reintroduza uma
constante de config root capturada no load do módulo para resolver paths: as
suítes de meetings apontam `CRAFT_CONFIG_DIR` para um tmpdir e voltariam a
escrever no `~/.craft-agent` real.

## Lint toolchain under TypeScript 7

`bun run lint` is a blocking gate again (`apps/electron` `build` and `validate:ci`
both run it), and the whole reason it can run is documented in
`docs/eslint-typescript7.md`. Read that before touching any of it.

- `typescript` stays on the 7.x native port. It has **no JS API**
  (`require('typescript')` yields only `version`/`versionMajorMinor`), which is
  what killed ESLint: `typescript-estree` reads `ts.Extension.Cjs` and
  `ts-api-utils` reads `ts.Intrinsic`, both at module load. No published
  `@typescript-eslint` release accepts TS 7 (`peerDependencies.typescript:
  ">=4.8.4 <6.1.0"`).
- The fix is scoped isolation, not a downgrade. `typescript-for-eslint`
  (`npm:typescript@5.9.3`) is a root devDependency, and the root `postinstall`
  runs `scripts/link-eslint-typescript.mjs`, which walks the lint dependency
  closure and gives each `typescript` consumer a nested link to that alias.
  `tsc` means TS 7 in every `typecheck:*` script; `bun run typecheck:all` must
  keep passing.
- The consumer list is discovered from the dependency graph, not hardcoded. Do
  not replace the walk with a literal array, and do not move the work out of the
  install lifecycle: a clean clone plus `bun install` has to be lintable with no
  manual step. `overrides`/`resolutions` cannot substitute — `typescript` is a
  peerDependency there, so there is no edge to rewrite.
- Waivers are pointed and carry a reason: an inline
  `eslint-disable-next-line <rule> -- why` at the site, or a file entry in the
  documented exception block of the flat config. Never turn a rule off globally
  to make the gate pass. `craft-styles/no-nonstandard-shadows` exceptions exist
  because the shadow scale is owned by design — swap a shadow for an approved
  token only when the equivalent is obvious, otherwise waive it.

## Browser pane CDP (`apps/electron/src/main/browser-cdp.ts`)

`BrowserCDP` owns the single `webContents.debugger` session of a browser pane.
The debugger idle-detaches after 5s because a permanently attached CDP debugger
is a passive bot-detection tell — that timeout is deliberate, not a knob to
widen when something races it. Preserve these invariants:

- Every dispatched command counts in-flight and `decideIdleDetach` gates the
  timer on that count: the countdown re-arms while a command is awaiting a
  response and only detaches at zero. Detaching mid-flight rejects the pending
  `sendCommand` with `target closed while handling command`, which is how a
  click was lost 1ms after an idle detach. Re-arming in the dispatch `finally`
  alone is NOT the gate — it protects the next command, never the running one —
  so the dispatch also re-arms right after `ensureAttached()`, and only while
  still attached, so an explicit `detach()` is not followed by another window.
  `ensureAttached`'s own `Emulation.setEmulatedMedia` reapplication goes through
  `sendGated` for the same reason, and the external `debugger.on('detach')`
  listener clears the timer the way `detach()` does.
- The gate is BOUNDED by `CDP_COMMAND_TIMEOUT_MS` (30s). A renderer blocked on
  `alert()`/`confirm()`, or a `Runtime.evaluate` over
  `navigator.clipboard.readText()` that never settles, would otherwise hold
  `inflight` at 1 forever and pin the debugger attached — the exact tell the
  idle detach exists to avoid. The deadline rejects the caller too: CDP has no
  cancel, so the abandoned command's later rejection is swallowed instead of
  escaping as an unhandled rejection. Do not replace this with a re-arm counter:
  that detaches but leaves the caller hanging forever.
- A click that could not be shown to land MUST NOT resolve: `clickElement` and
  `browser-pane-manager` record `lastAction.status: 'succeeded'` for anything
  that resolves. `clickAtCoordinates` replays through CDP once after a
  detached-target error, propagates if that replay fails, and propagates instead
  of emitting a native down/up pair once the press was delivered. When that
  detached-target error lands AFTER the press was delivered, the replay resends
  only `mouseReleased`: the renderer already saw the press and detaching does
  not retract it, so a full replay double-fires every `mousedown` handler and
  still resolves as success. `clickAtCDP` is that replay path, not dead code —
  it MUST keep `buttons: 1`/`buttons: 0` and the 20–60ms press-to-release gap,
  because a mousedown with `buttons === 0` and a 0ms click are trivial synthetic
  fingerprints right after a reattach. The `sendInputEvent` fallback keeps only
  its narrow slot (CDP unusable, nothing pressed yet) because it never reaches
  OOPIFs and cannot confirm delivery.
- Geometry read around a fill/select/file-input assignment is bookkeeping for
  the annotation overlay (`lastAction.geometry`), not the action's result. Both
  reads are best-effort via `tryReadGeometry` and the pre-action reading is the
  fallback; when the element has no box model at either end — the routine
  `<input type="file" style="display:none">` or a hidden `<select>` behind a
  styled dropdown — the action resolves with NO geometry. Hence
  `fillElement`/`selectOption`/`setFileInputFiles` (and
  `BrowserPaneManager.uploadFile`) return `ElementGeometry | undefined`. Never
  re-issue the strict read at the end: the action already mutated the page, so
  throwing there reports a completed upload as failed and the agent uploads
  twice. The pre-click geometry in `clickElement` stays strict — there it is the
  click target.
- Raw Blink node errors never reach the agent: `translateCdpNodeError` maps
  `Node cannot be found` / `No node with given id` onto the same stale-ref
  message `resolveRef` produces (`STALE_REF_ADVICE`), because the command had
  already passed `resolveRef` when navigation committed.
- Refs are per-document: the navigation listeners in the constructor invalidate
  `refMap`/`refDetails`/`backendNodeRefMap` and `nextRefCounter` is never reset.

## Agentic browser pane

`apps/electron/src/main/browser/` owns the pure, unit-testable decision layers
of the browser pane (`navigation-policy.ts`, `partition-hardening.ts`,
`favicon-transport.ts`); `browser-pane-manager.ts` only wires them into
Electron events and performs the side effects. Keep that split.

Nada escolhido por uma página carregada no pane pode virar requisição do
renderer privilegiado. O favicon é o caso que quase escapou:

- `page-favicon-updated` entrega a lista de candidatos escolhida pela página. O
  handler SHALL NOT propagar nenhuma delas; `BrowserInstance.favicon` só recebe
  uma `data:` URL produzida por `fetchFaviconDataUrl`, que busca os bytes na
  `session` da própria partition do pane (proxy daquele perfil) e valida
  esquema (`http:`/`https:`), status, content-type (allowlist raster —
  `image/svg+xml` é rejeitado de propósito) e tamanho (`FAVICON_MAX_BYTES`,
  32 KiB, checado no `content-length` e por chunk; `body` é obrigatório, não
  existe fallback que bufferize antes do teto).
- Toda allowlist é conjunto fechado, testada com `Object.hasOwn`. A chave é um
  header do atacante: com lookup por veracidade num object literal,
  `Content-Type: constructor` produzia `data:constructor;base64,<32 KiB>`.
  Vale para `normalizeFaviconContentType` e para `firstHeaderValue`.
- Redirect é revalidado salto a salto. O pane dirige `net.request` na session
  da partition com `credentials: 'omit'` e `redirect: 'manual'`, e só chama
  `followRedirect()` — **synchronously**, ou o Electron cancela — quando
  `shouldFollowFaviconRedirect` aprova o alvo, com teto de 2 saltos.
  `session.fetch` não serve aqui: `net.fetch` não registra listener de
  `redirect`, então `manual` só mata a requisição sem expor `Location`, e
  `follow` não dá como revalidar depois (`Response.url` é documentado como
  incorreto sob `net.fetch`).
- Os candidatos são percorridos em ordem (teto de 4, sequencial,
  single-in-flight) até um sobreviver às guardas. Sem isso o racional escrito
  para rejeitar SVG é falso: um site que anuncia `favicon.svg` primeiro
  perderia o PNG que vem em seguida.
- Qualquer guarda que falhe vira `null` em silêncio: favicon é decoração e não
  pode derrubar a instância, logar por navegação nem virar erro visível.
  `fetchFaviconDataUrl` nunca lança, então não há `catch` no caminho de wiring.
- `emitStateChange` nunca espera pelos bytes. `did-navigate`,
  `render-process-gone` e `finalizeDestroyedInstance` abortam a busca em voo, e
  `faviconToken` descarta resposta de uma página que já saiu de cena.
  `faviconAbort` é limpo em todo caminho terminal cujo token ainda é o
  corrente, não só no sucesso.
- A `data:` URL viaja em todo `emitStateChange`, que é broadcast `to: 'all'`
  (43.714 bytes no teto). `page-title-updated` emite sem throttle, então uma
  página hostil mexendo em `document.title` custa ~44 KB por push. Conhecido e
  aceito: coalescer `emitStateChange` muda ordem observável para todos os
  consumidores do estado do pane.
- A CSP do renderer (`apps/electron/src/renderer/index.html:6`) fica intacta —
  `data:` já está em `img-src`. Adicionar `http:`/`http://localhost:*` ali é o
  anti-fix: reabre o vetor de sondagem de portas locais que
  `openspec/changes/archive/2026-07-15-harden-navigation-and-ssrf/` fechou.
  O contrato completo está em
  `openspec/changes/harden-browser-favicon-transport/`.

## Browser cookie import

The macOS Chrome/Chromium reader lives under
`packages/shared/src/browser-cookies/`. Keep it independent from Electron and
keep decrypted values in memory only for the duration of a read. Never log,
persist in app JSON, or return decrypted cookie values from a tool/UI result.
Per-row decryption failures are counted as skipped and must not abort the read.

Browser profiles may declare `userOnly: true`. Preserve that flag through
`sanitizeBrowserProfileInput`, `normalizeBrowserProfile`, and
`normalizeBrowserProfileSettings`. Agent-owned (`ownerType: "session"`) browser
creation, profile switching, reuse, and binding must refuse a user-only profile
with an error before resolving a partition or creating/adopting an instance;
never fall back to `persist:browser-pane` for this refusal.
The default profile cannot be marked user-only through the profile UI. If
persisted input nevertheless marks it user-only, `resolveBrowserProfileId`
must enforce the same agent refusal before returning the legacy default
partition.

Cookie injection into an Electron partition lives in
`apps/electron/src/main/browser-pane-manager.ts`. `importCookies` must resolve
the profile capability before reading or writing, obtain the partition through
`getProfilePartition`, and use `session.fromPartition(...).cookies.set(...)`.
Explicit unknown profile ids must fail instead of falling back to the default
partition, and agent-intent imports must reject a domain that would disable the
reader filter.
Map Chrome SameSite integers to Electron strings, preserve dotted domains, and
count individual write failures as skipped without aborting the remaining
writes. Its result is counts-only (`imported`/`skipped`); do not expose this
phase-only method through `IBrowserPaneManager` or the remote bridge.

The user bulk-import surface is the `browserPane.IMPORT_COOKIES` RPC plus
`BrowserProfilePicker`. The handler must accept only a user-only target, force
`callerIntent: "user"`, and keep the manager's empty-domain bulk read internal.
The picker must identify Google Chrome's `Default` profile and the receiving
app profile before import, warn about the macOS Keychain prompt and agent
inaccessibility, and display counts only.

### Browser cookie import child index

- Reader and decrypted in-memory shape:
  `packages/shared/src/browser-cookies/`.
- Capability and partition resolution:
  `apps/electron/src/main/browser-profile-resolver.ts`.
- Electron cookie injection:
  `apps/electron/src/main/browser-pane-manager.ts`.
- User RPC registration and renderer contract:
  `apps/electron/src/main/handlers/browser.ts`,
  `apps/electron/src/transport/channel-map.ts`, and
  `apps/electron/src/shared/types.ts`.
- Profile creation and bulk-import UI:
  `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx` and
  `apps/electron/src/renderer/hooks/useBrowserProfiles.ts`.

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
  apps/electron/src/main/meetings/meeting-summary-service.test.ts \
  apps/electron/src/main/__tests__/i18n-bootstrap.test.ts \
  apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts \
  packages/shared/src/workspaces/__tests__/storage-meetings.test.ts
bun test ./apps/electron/src/main/meetings/output-language.isolated.ts \
  ./apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts \
  ./apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts
```

Para mudanças no host da call embutida ou na mecânica compartilhada de embed,
rode também as suítes do browser docado — elas são a prova de que o preview do
chat não regrediu:

```bash
bun test apps/electron/src/renderer/components/browser/__tests__/
```

For `browser-cdp.ts` (debugger lifecycle, click delivery, geometry, ref
translation) run the CDP harness plus the pane manager that consumes it:

```bash
bun test apps/electron/src/main/__tests__/browser-cdp.test.ts \
  apps/electron/src/main/__tests__/browser-pane-manager.test.ts
```

Para mudanças nas camadas puras do browser pane (navegação, hardening de
partition, favicon transport), rode:

```bash
bun test apps/electron/src/main/browser/__tests__/
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

For lint-toolchain changes (root `typescript` pin, `typescript-for-eslint`,
`scripts/link-eslint-typescript.mjs`, `postinstall`, any flat config or custom
rule), prove the linter still comes up from a clean install and that the custom
rules still behave:

```bash
rm -rf node_modules && bun install && bun run lint
bun test packages/ui/eslint-rules/__tests__/ apps/electron/eslint-rules/__tests__/
bun run typecheck:all
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
