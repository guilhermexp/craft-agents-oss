## 1. Contrato e evidência

- [x] 1.1 Registrar proposal, design, tasks e deltas das quatro capabilities.
- [x] 1.2 Importar os sete arquivos em `docs/denchclaw/` e anotar evidência
      confirmada, defeitos upstream e decisões Craft contra o SHA fixado.
- [x] 1.3 Validar `add-structured-workspace-objects` em modo strict.

## 2. Phase A — U1: domínio e SQLite

- [x] 2.1 Escrever primeiro os testes de initialization/migrations idempotentes,
      campos tipados, relações e rollback.
- [x] 2.2 Implementar schema e repository em
      `packages/shared/src/workspace-objects/` usando somente o adapter SQLite
      compartilhado.
- [x] 2.3 Escrever primeiro os testes de read projection ausente/stale e fallback
      por rows normalizadas.
- [x] 2.4 Implementar projeção revisionada reconstruível e lifecycle de handles.

## 3. Phase A — U2: data plane, manifests e guidance

- [x] 3.1 Escrever primeiro testes de transaction, stable identity, repair,
      conflito e `projection-error` pós-commit.
- [x] 3.2 Implementar service comum e protocolo recuperável SQLite → manifest →
      evento pós-commit.
- [x] 3.3 Escrever primeiro testes do schema/handler genérico e paridade de
      envelope entre registry e session MCP.
- [x] 3.4 Registrar a tool versionada no frontier, expor no session MCP e limitar
      guidance contextual a backends/workspaces compatíveis.

## 4. Phase A — U3: tabs e resolver

- [x] 4.1 Escrever primeiro testes do reducer para preview replacement,
      promotion, pinning, restore e active selection repair.
- [x] 4.2 Implementar targets e tabs determinísticos com persistence escopada.
- [x] 4.3 Escrever primeiro regressões para eviction real do payload 21,
      AbortController em load/refresh e generation stale.
- [x] 4.4 Implementar resolver discriminado com limite 20 e SWR sem flicker.

## 5. Phase A — U4: bridge, watcher e sidebar

- [x] 5.1 Escrever primeiro testes server-core/preload para subscription por
      workspace, revision dedupe, reconnect e teardown no último cliente.
- [x] 5.2 Implementar RPC/event bridge e watcher debounced que ignore DB/WAL/SHM
      e temporários.
- [x] 5.3 Escrever primeiro testes de routing e scope para tabs de arquivo/objeto,
      preservando viewers especializados e troca de sessão/workspace.
- [x] 5.4 Integrar tab strip e preview modular na sidebar direita existente com
      i18n e sem god-component.

## 6. Gate Phase A

- [x] 6.1 Testes de regressão focados de U1-U4, typechecks afetados e validações do repo
      passam sem skips novos.
- [x] 6.2 DOX pass atualiza a cadeia de documentação afetada e o OpenSpec volta a
      validar em strict.
- [x] 6.3 `vibe-security` e Coderabbit não reportam blocker no delta da fase.
- [x] 6.4 Smoke real no Electron comprova agente → create/update object → evento →
      sidebar, tabs, SWR, workspace switch e watcher teardown.
- [x] 6.5 `openspec-phase-auditor` retorna GO antes de Phase B.

Closeout de regressão de 6.1/6.2 (2026-08-01): a suíte focada U1-U4 passou
56/56 em 13 arquivos; os typechecks afetados de shared, server-core e Electron
passaram, assim como `typecheck:all`. `lint:tool-contracts` confirmou 30 tools
native + 2 MCP-only, `lint:i18n:parity` confirmou 7 locales com 1.755 keys cada,
`openspec validate add-structured-workspace-objects --strict` retornou valid e
`git diff --check` saiu limpo. O DOX pass corrigiu o lifecycle Craft do watcher
e esta evidência sem alterar proposal, design ou specs.

Evidência parcial de 6.3 (2026-08-01): `vibe-security` não encontrou blocker
no delta e o Gitleaks ficou limpo tanto no commit da fase quanto no staged
follow-up. A segunda rodada do Coderabbit reportou cinco achados, todos
corrigidos com regressões; a terceira rodada foi bloqueada pelo rate limit do
serviço antes de revisar. O gate permanece aberto até a confirmação automática.

Closeout de 6.3 (2026-08-01): o Coderabbit concluiu a revisão integral de
`c375a1fb..dc5767b4` com zero blocker e dois achados `minor`, ambos restritos ao
índice DenchClaw. A contagem foi alinhada aos seis documentos técnicos e a
proveniência passou de `HEAD` para o SHA imutável
`f14eb4c239002d7b28673c60955b689b9d69db22` em `c4bc21a8`.

Evidência de 6.4 (2026-08-01): o session MCP empacotado executou
`workspace_objects` e retornou revisões 3 e 4 com status `ready`; a janela
Electron isolada atualizou `People` de `Lead` para `Active` sem reload. Depois
da troca para outro workspace, um listener de diagnóstico recebeu zero eventos
do workspace anterior; ao voltar, a tab escopada restaurou a revisão 4. Um
fault injection de leitura manteve o payload anterior visível, mostrou retry e
recuperou após o storage voltar a ficar disponível.

Reteste final de 6.4 (2026-08-01): após o build definitivo, o MCP empacotado
migrou o fixture para schema SQLite v2 e concluiu delete/update até a revisão 7
com status `ready`; a janela Electron recebeu o evento sem reload e exibiu uma
única entrada `Ana / Active`. Os processos de teste encerraram com teardown dos
watchers e recursos do workspace.

Regressão MCP SDK de 6.4 (2026-08-01):
`packages/session-mcp-server/src/workspace-objects-schema.test.ts` valida com o
AJV do SDK que o `outputSchema` publicado aceita o `structuredContent` real sem
exigir o envelope interno `content`. Após rebuild de `session-mcp-server`, um
`Client` oficial com `StdioClientTransport` listou 30 tools, observou
`workspace_objects` com raiz `type: object` e sete branches, e executou via
`client.callTool()` `define-object` na revisão 1, `upsert-entries` na revisão 2
e `get-object` com a entry `Ana / Active`, todos sem bypass de validação.

Artefato rastreável de 6.4: `docs/artifacts/structured-workspace-objects-phase-a/`
preserva o roteiro, os payloads MCP de create/update/get, as capturas do
Electron real para as revisões 1 → 2 e 2 → 3, troca sem vazamento para o
workspace de controle, restauração da tab escopada e o log de desconexão do
cliente RPC no fechamento da janela.

Closeout de 6.5 (2026-08-01): o `openspec-phase-auditor` reavaliou em modo
read-only `c375a1fb..4c0e4d46`, confirmou as evidências de 6.1–6.4 e retornou
GO sem blocker concreto, liberando a Phase B.

## 7. Phase B — U5/U6: views editáveis

- [x] 7.1 Escrever testes de saved views, filtros, ordering, column visibility e
      field editors antes da implementação de U5.
- [x] 7.2 Implementar query compartilhada, saved views e table editável com
      confirmação somente após commit.
- [x] 7.3 Escrever testes do registry de adapters, configurações vazias e rollback
      Kanban para rejeição e transporte antes da implementação de U6.
- [x] 7.4 Implementar table, Kanban, calendar, timeline, gallery e list sobre um
      único payload.
- [ ] 7.5 Validar testes, Electron real e auditor GO antes de Phase C.

Evidência U5 7.1/7.2 (2026-08-01): o primeiro RED executou as duas suítes U5
antes dos arquivos de produção e retornou `0 pass / 2 fail`, com
`Cannot find module '../query.ts'` e
`Cannot find module '../ObjectFieldEditor'`. REDs incrementais também
reproduziram `query-object` ausente, restore ignorando `ContentTarget.viewId`,
presentation settings sem aplicação e query relacional comparando o stable ID
em vez do label atual. A revisão final acrescentou um RED de compatibilidade
para views loose já persistidas pela Phase A: a reconstrução devolvia a view
como ausente até o leitor normalizá-la para v1.

O GREEN final passou 99/99 em 16 arquivos: as suítes U5 cobrem schema v1
estrito, filtros booleanos aninhados, search, multi-sort estável, columns
ocultas, settings/restauração da table, os nove field types, inputs inválidos
sem mutation, relation rename preservando ID, resposta rejeitada, exceção de
transporte, compatibilidade de views Phase A e confirmação somente após
revalidation da revisão commitada. A matriz inclui as regressões U1-U4 de
storage/projection/manifest/service,
frontier/MCP, tabs/resolver/eventos/reconnect, sidebar e watcher. O action
`query-object` provou paridade entre saved view do agente e config inline da UI,
inclusive relações resolvidas pelo mesmo helper shared.

Gates U5: `typecheck:all` passou; `lint:tool-contracts` confirmou 30 tools
native + 2 MCP-only; `lint:i18n:parity` confirmou 7 locales com 1.780 keys;
React Doctor retornou 100/100; `impeccable detect` saiu 0; OpenSpec strict e
`git diff --check` passaram. A table está ligada ao
`WorkspaceObjectPreviewPanel`/`ContentPreviewHost`, usa as actions U2
`upsert-entries`/`upsert-view` e preserva o resolver SWR existente. U6, smoke
Electron/auditoria de Phase B e 7.5 não foram iniciados nem marcados.

Correção consolidada U5 7.1/7.2 (2026-08-01): REDs focados reproduziram nove
falhas comportamentais e duas exports ausentes, seguidos por regressões
incrementais para deduplicação do retarget, isolamento por workspace/view,
lookup dos relation IDs referenciados e migration marker v3. As correções
persistem `viewId` no target canônico da tab, impedem payload stale durante a
troca, usam `entry.id` no TanStack Table, migram configs Phase A arbitrárias
para v1 numa transação e mantêm novos writes estritos. O frontier MCP espelha
settings recursivos e refinements shared sem converter a recursão em `{}`.

O mesmo round tornou `query-object` serializável com `displayValues` e
`relationLabels` sem substituir IDs em `entries`, adicionou paginação bounded
de relações com inclusão das referências atuais, rejeitou strings locais acima
de 64.000 caracteres antes da mutation e passou a ordenar/filtrar datas pelo
instante. O GREEN focado final passou 88/88 em 14 arquivos (437 expects),
incluindo validação AJV do transporte MCP; os typechecks de shared, Electron e
session-tools passaram. `lint:tool-contracts` confirmou 30 tools native + 2
MCP-only e `lint:i18n:parity` confirmou 7 locales com 1.781 keys.

O golden de contratos foi regenerado com 32 tools: o delta de +437/-1.937
linhas decorre de `$refStrategy: root`, que deduplica schemas repetidos em 19
refs locais; `workspace_objects` preserva todos os nove branches e não contém
`items: {}`. React Doctor latest 0.9.3 não reportou diagnóstico nos hunks U5
alterados; o scan global permaneceu em 72/100 com 48 issues fora deste escopo.
U6, 7.3, 7.4, smoke/auditoria de Phase B e 7.5 continuam não iniciados e não
foram marcados.

Segundo re-review corretivo U5 7.1/7.2 (2026-08-01): REDs observados provaram
`ZodError` para `columns: ['']`, abort da migration v3 no reopen, perda de 2
labels entre 202 refs, ausência de batching no preview, `anyOf` na raiz do
schema enviado ao Pi, resync local por revision genérica, cursor incoerente
após revalidation e igualdade temporal textual para offsets equivalentes. Um
RED adicional confirmou que `JSON.stringify` de valor legacy não serializável
também escapava do normalizador.

O GREEN isola/faz fallback de cada row Phase A, aceita apenas column IDs string
de 1–120 caracteres, particiona refs em batches de até 200 e rejeita falha ou
mistura de revisions. Relações carregam revision, preservam páginas/cursor no
mesmo snapshot e resetam no snapshot novo. Saved views sincronizam apenas pelo
fingerprint da própria config canônica; os quatro operadores de igualdade/set
para date/datetime comparam `Date.parse`. MCP preserva a union estrita, enquanto
Pi/Anthropic/Copilot recebem `nativeInputSchema` object-only com os payloads
visíveis; o canonical parse continua obrigatório.

A matriz final passou 102/102 em 16 arquivos (628 expects), incluindo AJV MCP e
catálogo Pi; typechecks de shared, Electron, session-tools e pi-agent-server
passaram. `lint:tool-contracts` confirmou 30 native + 2 MCP-only, i18n manteve
7 locales com 1.781 keys, OpenSpec strict e `git diff --check` passaram. React
Doctor latest 0.9.3 line-scoped terminou com 0 issues. O golden não mudou:
continua com 32 tools, nove actions de `workspace_objects`, 19 refs locais e
zero `items: {}`. U6, 7.3, 7.4, smoke/auditoria de Phase B e 7.5 permanecem não
iniciados e desmarcados.

Terceiro re-review corretivo U5 7.1/7.2 (2026-08-01): os REDs focados
reproduziram uma exceção síncrona no updater de load-more, rejeição de
transporte escapando como promise rejeitada, ausência de snapshot de leitura
atômico entre revision e opções e merge de batches com revisions divergentes.
O GREEN transforma falhas/mismatch do load-more em estado recuperável sem
descartar a página canônica mais nova, permite retry da primeira página e
executa revision, options e batches de `query-object` no mesmo snapshot SQLite.
Uma validação defensiva rejeita qualquer lote misto antes de montar labels.

A regressão ampliada passou 107/107 em 18 arquivos (705 expects), e os
typechecks de shared e Electron passaram. React Doctor latest 0.9.3 line-scoped
terminou com 0 issues; OpenSpec strict e `git diff --check` passaram. Não houve
mudança no contrato público da tool, portanto golden/tool contracts não foram
regenerados. U6, 7.3, 7.4, smoke/auditoria de Phase B e 7.5 continuam não
iniciados e desmarcados.

Residual final U5 7.1/7.2 (2026-08-01): o RED observou que o retry fazia apenas
uma request e aceitava páginas de revisions diferentes, perdendo labels e IDs
válidos acima da primeira página de 200. O GREEN extrai o lookup inicial para
um helper compartilhado com a table e refaz first-page mais todos os IDs
referenciados em batches de até 200. O cache só é substituído depois que todas
as páginas concordam na revision; transporte ou mismatch preservam o snapshot
anterior com erro recuperável. As suítes focadas de UI/relation passaram 51/51
(143 expects), com typechecks shared e Electron verdes. U6, 7.3, 7.4, smoke e
7.5 permanecem não iniciados e desmarcados.

Race final U5 7.1/7.2 (2026-08-01): o RED reproduziu retry r8 em voo, refresh
instalando r9 e resposta r8 sobrescrevendo cache, cursor e label novos. O GREEN
aplica monotonicidade no replace: revision menor é descartada com erro
recuperável, enquanto igual ou maior substitui normalmente, sem throw nem
generation token. A matriz focada passou 52/52 (146 expects), e os typechecks
shared/Electron passaram. U6, 7.3, 7.4, smoke e 7.5 continuam não iniciados e
desmarcados.

Evidência U6 7.3/7.4 (2026-08-01): o RED da nova suíte executou antes da
produção e retornou `0 pass / 1 fail`, com `Cannot find module
'../ObjectViewHost'`. O GREEN registra table, Kanban, calendar, timeline,
gallery e list num host único dentro do preview existente. Todos recebem o
mesmo `WorkspaceObjectPayload` e `WorkspaceObjectQueryResult` do evaluator U5;
adapter/settings continuam no saved view v1, sem storage ou projeção paralela.

Config ausente ou incompatível produz estado vazio com seleção de field e ação
de configuração. O Kanban usa entries/stable IDs genéricos e as primitives DnD
existentes, persiste a entry completa pelo commit envelope e mantém o override
otimista até revalidation. Envelope rejeitado, `projection-error`, canonical
mismatch ou throw de transporte removem o override e restauram a coluna
original com erro visível. A matriz U5+U6 passou 75/75 em oito arquivos (224
expects); typechecks Electron/shared e i18n parity passaram, com 7 locales e
1.792 keys. React Doctor latest 0.9.3 terminou com 0 issues e `impeccable@3
detect` saiu 0. O DOX e a documentação DenchClaw foram atualizados. 7.5,
Electron real e auditoria Phase B não foram executados nem marcados.

## 8. Phase C — U7: discovery e health

- [ ] 8.1 Reconciliar esta fase com a conclusão de `harden-credential-storage`.
- [ ] 8.2 Escrever testes de catálogo, OAuth metadata, redaction e session probe.
- [ ] 8.3 Implementar catálogo Composio subordinado a sources/OAuth e credential
      storage existentes.
- [ ] 8.4 Validar toolkit real, logs/payloads redacted e auditor GO antes de
      Phase D.

## 9. Phase D — U8/U9: inbox, calendário e relacionamentos

- [ ] 9.1 Escrever testes Gmail de checkpoint-before-page, replay idempotente,
      rate limit, self-exclusion e body hydration.
- [ ] 9.2 Implementar inbox Gmail e counterpart interactions sobre objetos.
- [ ] 9.3 Escrever testes Calendar de timezone, cancellation, recurrence,
      incremental token expiry e full reconciliation.
- [ ] 9.4 Implementar Calendar sync e relationship aggregation multi-source.
- [ ] 9.5 Validar mailbox/calendar reais, sanitizer, resume e auditor final GO.

## 10. Encerramento

- [ ] 10.1 Atualizar documentação operacional de backup, repair e recovery sem
      instruir edição direta do SQLite.
- [ ] 10.2 Rodar gates finais de repo, OpenSpec, segurança, review e Electron.
- [ ] 10.3 Confirmar que WebUI/remote continuam explicitamente fora da Phase A e
      registrar change posterior de paridade antes do archive.
