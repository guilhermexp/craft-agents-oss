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

- [ ] 7.1 Escrever testes de saved views, filtros, ordering, column visibility e
      field editors antes da implementação de U5.
- [ ] 7.2 Implementar query compartilhada, saved views e table editável com
      confirmação somente após commit.
- [ ] 7.3 Escrever testes do registry de adapters, configurações vazias e rollback
      Kanban para rejeição e transporte antes da implementação de U6.
- [ ] 7.4 Implementar table, Kanban, calendar, timeline, gallery e list sobre um
      único payload.
- [ ] 7.5 Validar testes, Electron real e auditor GO antes de Phase C.

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
