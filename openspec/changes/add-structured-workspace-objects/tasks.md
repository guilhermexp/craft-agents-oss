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

- [x] 6.1 Testes focados de U1-U4, typechecks afetados e validações do repo
      passam sem skips novos.
- [x] 6.2 DOX pass atualiza a cadeia de documentação afetada e o OpenSpec volta a
      validar em strict.
- [ ] 6.3 `vibe-security` e Coderabbit não reportam blocker no delta da fase.
- [ ] 6.4 Smoke real no Electron comprova agente → create/update object → evento →
      sidebar, tabs, SWR, workspace switch e watcher teardown.
- [ ] 6.5 `openspec-phase-auditor` retorna GO antes de Phase B.

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
