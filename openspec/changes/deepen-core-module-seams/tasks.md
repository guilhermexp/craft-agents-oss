# Tasks

## 1. session-tools-mcp — declaração única para backend-mode tools

- [x] 1.1 Registrar `list_background_tasks` via `defineTool` (handler, capability,
      callback, binding e system prompt já existem) ou removê-lo do system prompt.
- [x] 1.2 Adicionar `projectId` ao `SpawnSessionSchema` — direção segura para v1,
      já que o adapter Claude aceita hoje.
- [x] 1.3 `llm-tool.ts` passa a derivar schema/descrição do catálogo canônico;
      `thinking`/`thinkingBudget` voltam a existir no caminho Claude.
- [x] 1.4 `spawn-session-tool.ts` e `browser-tools.ts` idem — sobra só execução.
- [x] 1.5 Tornar `def.handler` inalcançável de fora; `executeSessionTool` passa a
      resolver por nome. `pi-agent.ts:1655-1662` passa a chamá-lo (valida input+output).
- [x] 1.6 Checker passa a iterar o conjunto **não registrado** (handlers exportados,
      nomes alcançáveis por backend) e falha com a mensagem de bypass que a spec exige.
- [x] 1.7 Regerar `scripts/session-tool-contracts.golden.json`.
- [x] 1.8 Substituir os dois testes de paridade por-nome por uma asserção de
      igualdade de catálogo nos quatro consumidores.

## 2. agent-backends — adotar o dispatcher morto

- [x] 2.1 Ligar `ToolPermissionDispatcher`; ele passa a ser dono do mapa de
      pending permissions, da montagem do input e da tradução dos 7 arms.
- [x] 2.2 Resolver explicitamente as quatro divergências Claude/Pi via
      `rerunAfterActivation` em vez de por acidente.
- [x] 2.3 `respondToPermission` sobe para `BaseAgent`, como já acontece com
      `respondToUserQuestion`.
- [x] 2.4 Testes no interface do dispatcher cobrindo as quatro divergências.

## 3. credential-storage — resolver por valor

- [x] 3.1 Adicionar resolvedor `authType → credencial` em `CredentialManager`;
      `hasLlmCredentials` passa a derivar dele em vez de ser cópia paralela.
- [x] 3.2 Colapsar as três re-derivações (`drivers/anthropic.ts:124-142`,
      `config/llm-connections.ts:1046-1079`, `pi-agent.ts:686-743`).
- [x] 3.3 Placeholder keyless vira uma constante (hoje `'ollama'` em
      `anthropic.ts:137` e `'not-needed'` em `llm-connections.ts:1054`, com
      condições de disparo diferentes).
- [x] 3.4 Deletar `sources/credential-strategies/` (804 linhas, 0 chamadores) e
      `drivers/pi.ts:318`. Manter o check de liveness em `anthropic.ts:145-158`.

## 4. hermes-embed — resolução do interceptor

- [x] 4.1 Resolver o interceptor a partir da raiz do workspace; a busca
      ascendente não pode casar sob `apps/electron/packages/`.
- [x] 4.2 Scripts de build passam a montar em diretório de saída já ignorado.
- [x] 4.3 Estender o teste de packaging contract com o caso "resolvido a partir
      de `apps/electron`".

## 5. hermes-dashboard-host — extrair o manager

- [x] 5.1 Mover `HermesRuntimeManager` para módulo próprio com as 22 free
      functions atrás dele.
- [x] 5.2 Adicionar os métodos que o design arquivado nomeou (`getRuntimeDetails`,
      `patchApiConfig`, `listEnv`, ...). `hermes.ts` colapsa para delegação.
- [x] 5.3 Testes de env merge e fallback de provider viram chamadas diretas, sem
      subprocess, binário temporário ou servidor HTTP.

## 6. settings-and-config — dispatch e migrations

- [x] 6.1 Uma tabela `kind → schema`; `ValidatorInterface` encolhe.
- [x] 6.2 `SkillMetadataSchema` passa a ter uma casa só.
- [x] 6.3 Lista de fases de migration vira dados com id; runner puro sobre
      `StoredConfig`, devolvendo aplicadas e falha.
- [x] 6.4 `migrationsApplied` passa a ser lido/escrito ou é deletado.

## 7. session-management — completar o split arquivado

- [x] 7.1 Deletar `SessionLifecycleManager` (0 chamadores) e resolver a colisão
      de nome com `agent/core/session-lifecycle.ts`.
- [x] 7.2 Publisher vira dono único da emissão. Primeira passada só removeu o
      wrapper `private sendEvent()`, inlinando 92 call sites para
      `this.events.publish(...)` — ainda dentro de `SessionManager.ts`. O split
      real foi feito depois (ver Follow-up): os 102 sites passaram a chamar
      operações de domínio do `SessionEventPublisher` e nenhum payload de
      `SessionEvent` é montado fora dele.
- [x] 7.3 Store vira dono único da persistência. Primeira passada removeu o
      wrapper `private persistSession()` e moveu o bloco de turn-anchor sidecars
      (~168 linhas: load/save Pi + Claude, copy-for-branch) para
      `SessionMessageStore`. O split real foi feito depois (ver Follow-up): a
      orquestração de fila (`persist` + `flush` + guard de metadata) virou
      `persistNow` / `persistNowDetached` / `persistMetadataNow` no store.
- [x] 7.4 Testes passam a rodar no interface dos três módulos, sem `as any`.

## 8. protocolo — contrato tipado único

- [x] 8.1 **Escopo entregue** (≠ título): `channels.ts` (`RPC_NAMESPACES`) permanece
      byte-idêntico. Criou-se `RPC_CONTRACT` em `apps/electron/src/shared/types.ts`,
      que declara cada leaf (canal referenciando `RPC_NAMESPACES` + assinatura
      fantasma) e do qual `ElectronAPI`/`CHANNEL_MAP` derivam. Fica a jusante de
      `server-core`, então nenhum handler pode ser tipado contra ele.
- [x] 8.2 `ElectronAPI`, `CHANNEL_MAP` e `HANDLED_CHANNELS` passam a derivar.
- [x] 8.3 Remover `transform` (um único call site) e a lista de exclusão de 14 nomes.
- [x] 8.4 Os dois testes de paridade viram tautologia e são deletados.

## 9. browser panes

- [x] 9.1 `BrowserPaneFns` vira a interface única voltada ao agente.
- [x] 9.2 `IBrowserPaneManager` desce para transporte; sumir com os 8 pares sync/async
      e com os valores fabricados do adapter remoto.
- [x] 9.3 Seams internos: navigation policy, partition hardening, toolbar host,
      theme extraction.
- [x] 9.4 Unificar o gate `allowRemoteEvaluate` num caminho só.

## 10. messaging-gateway

- [x] 10.1 Accessor de leitura para `WorkspaceState` (fim dos ~11 `as any`).
- [x] 10.2 Métodos de credencial por plataforma viram genéricos via `MessageAdapterRegistry`.
- [x] 10.3 Mutadores da matriz de acesso mudam para junto do avaliador.

## 11. renderer

- [x] 11.1 Uma casa para a projeção de Turn: uma identidade, um cache, uma
      polaridade de expansão. Deletar os 7 exports sem chamadores.
- [x] 11.2 Quebrar `TurnCard` nas três preocupações já fisicamente separadas.
- [x] 11.3 Quebrar `AppShellContextType` por substantivo de domínio; renomear o
      `useSession` de seleção.

## 12. Verificação

- [x] 12.1 `bun test` focado em Hermes/Craft conforme AGENTS.md.
- [x] 12.2 `bun run lint:tool-contracts`.
- [x] 12.3 `bun run typecheck` e `bun run lint:i18n:parity`.
- [x] 12.4 Atualizar `apps/electron/docs/hermes-embed.md` se o contrato mudar.

## Estado verificado ao fechar

Gates do projeto, todos verdes: `bun run validate:ci` sai 0,
`bun run typecheck:all` tem 0 erros (o HEAD de partida tinha 6),
`bun run lint:tool-contracts` reporta 29 native + 2 mcp-only,
`bun run lint:i18n:parity` OK.

Suítes comparadas contra um worktree limpo em HEAD com `node_modules`
próprio (sem isso os symlinks de workspace apontam para a árvore suja e o
baseline mente): **63 testes falhando em HEAD → 36 agora, zero regressões,
27 falhas pré-existentes corrigidas**. Ganho grande veio de eliminar um
vazamento de `mock.module` que derrubava arquivos inteiros antes de rodarem
(`apps/electron/src/main`: 275 pass/10 fail+2 errors → 360 pass/0 fail).

### Falhas remanescentes (todas pré-existentes, nenhuma introduzida aqui)

Fora do escopo deste change; ficam como trabalho futuro:

- 8 `i18n locale parity` (o gate `lint:i18n:parity` passa; estes são testes
  de unidade com expectativa própria)
- 9 regras eslint de z-index em `packages/ui`
  (`no-floating-z-tokens-in-island`, `no-hardcoded-z-index`)
- 3 `workspace storage: meetings directory`
- 3 `getProviderIconThemeClassName`
- 4 de markdown/link (`preprocessLinks`, `detectLinks`,
  `markdownUrlTransform`, `ReactMarkdown anchor rendering`)
- 2 `guardLargeResult contextWindow handling`
- 1 cada: `registerSystemCoreHandlers OPEN_URL`,
  `native agent runtime contract`, `handleInterrupted (#616)`,
  `Transport — error code preservation`,
  `Pi agent server packaging contract` (binários pré-compilados ausentes),
  `ClaudeConfigManager` (`getDefaultOptions` escreve `.claude.json`),
  e um caso sem nome (`mention-menu`, `DOMMatrix` de pdfjs em ambiente sem DOM)

### Colisões de nome resolvidas no caminho

Cinco identificadores significavam coisas sem relação:
`SessionLifecycleManager` (resolvida deletando o pass-through morto),
`useSession` (seleção vs dados), `useSessionActions` (seam de domínio vs
decorador de toast), `SessionStatus` (estado de execução vs objeto de config,
renomeado para `ResolvedSessionStatus`) e `AgentEvent` (nome de hook de
automation vs evento de streaming, renomeado para `AgentHookEvent`) — este
último tinha `base-agent.ts` importando os dois no mesmo arquivo via alias.

## Correção pós-smoke-test (renderer)

Rodar o app expôs uma regressão que nenhum teste nem o typecheck pegam: o
renderer passou a quebrar em `secure-storage.ts:1` com
*"Module 'crypto' has been externalized for browser compatibility"*.

Causa: ao unificar o placeholder keyless, `config/llm-connections.ts` passou a
importar `KEYLESS_API_KEY_PLACEHOLDER` de `credentials/manager.ts`. Quatro
arquivos do renderer importam **valores** de `@config/llm-connections`
(`model-picker-helpers.ts`, `useModelVisionToggle.ts`, `CompactModelSelector.tsx`,
`ModelPickerControl.tsx`), então a cadeia
`renderer → llm-connections → credentials/manager → backends/secure-storage →
node:crypto` entrou no bundle do browser. A linha vizinha
`import type { CredentialManager }` era inofensiva por ser type-only; o import
de valor não era.

Correção: a constante mudou para `credentials/types.ts`, que não tem nenhum
import e é o módulo-folha correto para um valor compartilhado entre o lado Node
e o renderer. `manager.ts`, `anthropic.ts`, o barrel e o teste passaram a
apontar para lá.

Provado por bundling real (`bun build --target=browser` de `llm-connections.ts`
→ 3 módulos, zero `createCipheriv`/`SecureStorageBackend`) e por carregar o
renderer servido pelo Vite: zero `pageerror` e zero mensagens relacionadas a
crypto. O erro original acontecia em tempo de avaliação do módulo, então
independia de preload.

**Lição para a próxima onda**: `bun test` (esbuild, sem checagem de tipo) e
`typecheck:all` não cobrem o grafo de import do bundle do renderer. Mudança em
`packages/shared` alcançável pelo renderer precisa de smoke test no app.

### Vazamentos de `mock.module` corrigidos no caminho

Mocks parciais substituem o módulo para todos os arquivos seguintes do mesmo
processo de teste, derrubando arquivos inteiros antes de rodarem:

- `apps/electron/src/main/**` — sete mocks de `../logger` e um do módulo de
  credenciais. Unificados em `apps/electron/src/main/__tests__/logger-module-stub.ts`.
  Resultado: 275 pass/10 fail+2 errors → **360 pass/0 fail**.
- `packages/shared/src/config/__tests__/assert-remote-evaluate.test.ts` — mock
  parcial de `../storage.ts`. Passou a espalhar o namespace real, seguindo o
  padrão que `prompt-cache-env.isolated.ts` já usava.
  Resultado na combinação afetada: 217 pass/5 fail+5 errors → **287 pass/0 fail**.

## Follow-up — split real de session-management (executado)

As tasks 7.2/7.3 tinham sido fechadas com escopo **menor** que o título
arquivado: o inline dos wrappers deixou `SessionManager` chamando
`this.events.publish(...)` e `this.store.persist(...)` diretamente nos mesmos
~92/49 pontos, o que **aumentava** o acoplamento à superfície dos dois módulos
em vez de reduzi-lo. Este follow-up executou o split de verdade.

- [x] **Emissão → `SessionEventPublisher`.** Os 102 sites de emissão
      (92 `publish` + 5 `publishWorkspaceChanged` + 4 `publishAll` +
      1 `publishClient`; mais os 2 `publishToClient`) passaram a chamar
      operações de domínio. Nenhum payload de `SessionEvent` é montado fora do
      publisher — `grep 'this.events.publish'` em `SessionManager.ts` dá zero.
      O módulo ganhou ~40 operações agrupadas por evento/domínio, e não um
      método por call site:
      - polaridade colapsada em um argumento: `flagChanged(session, bool)`,
        `archiveChanged`, `shareChanged(session, url | null)`,
        `titleRegenerating`, `asyncOperation`;
      - projeção de payload internalizada: `permissionModeChanged` faz o
        rename `lastChangedBy/lastChangedAt → changedBy/changedAt` do registro
        de diagnostics; `connectionChanged` recebe o corpo tipado;
      - `asyncOperation` também espelha `isAsyncOperationOngoing`, então flag e
        evento não podem mais divergir (eram 8 pares duplicados);
      - `forwardBackgroundTaskEvent` é o único caminho verbatim (preserva
        `kind`/`workflowId`, que o renderer lê);
      - o vocabulário de canal (`RPC_NAMESPACES.*`) saiu do `SessionManager`:
        `workspaceLabelsChanged`, `appThemeChanged`, `unreadSummaryChanged`,
        `sessionFilesChanged`, `clientSendFailed`, etc.;
      - `getSink()` (só usado como guarda) virou `hasSink()`, então o sink não
        vaza mais para fora do publisher.
- [x] **Persistência → `SessionMessageStore`.** 25 dos 49 sites eram
      orquestração de fila (`persist` + `flush` manual, com ou sem `await`) e
      viraram operações do store: `persistNow` (14), `persistNowDetached` (4) e
      `persistMetadataNow` (7). Os 24 restantes são `persist(managed)` puro — já
      é a operação do store, não há orquestração para mover. O guard de
      self-write migrou junto: `setMetadataWriteGuard` e
      `METADATA_WRITE_GUARD_MS` saíram do `SessionManager` e viraram parte de
      `persistMetadataNow`. `this.flushSession(managed.id)` interno: zero
      ocorrências; sobra só o `flush` dentro do wrapper público homônimo.
- [x] **Cobertura.** `session-event-publisher.test.ts` passou a exercer a API de
      domínio (scoping, polaridade, projeção de diagnostics, preservação das
      chaves opcionais, forward verbatim, roteamento de canal, `hasSink`);
      `session-message-store.test.ts` cobre `persistNow` e o arming do guard em
      `persistMetadataNow`.

`SessionManager.ts`: 9.133 → 8.857 linhas. Gates: `typecheck:all` exit 0;
`bun test packages/server-core` 262 pass / 2 fail (as mesmas 2 pré-existentes:
`Transport — error code preservation` e `registerSystemCoreHandlers OPEN_URL`);
`lint:tool-contracts` 29 native + 2 mcp-only; `openspec validate --strict` valid.
