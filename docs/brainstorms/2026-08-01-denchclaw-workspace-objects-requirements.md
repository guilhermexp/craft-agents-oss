---
date: 2026-08-01
topic: denchclaw-workspace-objects
---

# DenchClaw-inspired workspace objects

## Summary

Evoluir o Craft Desktop para que agentes e usuários compartilhem objetos estruturados, arquivos e views persistentes no workspace. A entrega será faseada: primeiro a fundação de dados e preview reativo; depois CRM, views ricas, integrações, inbox e calendário sobre o mesmo contrato.

---

## Problem Frame

Hoje o Craft já renderiza arquivos e blocos ricos, possui uma sidebar com árvore e preview inline, fontes OAuth, watchers de configuração, tasks e um Kanban de sessões. Essas capacidades vivem em superfícies separadas e não formam um workspace estruturado que o agente possa modificar e a UI refletir sem uma ferramenta específica por feature.

O DenchClaw demonstra um loop útil: o agente altera dados e arquivos; o runtime observa; a UI resolve o conteúdo e atualiza a view. A análise do upstream também mostrou defeitos que não devem ser herdados, incluindo cache nominalmente limitado sem remoção de payloads, cancelamento incompleto de refresh e identidade projetada com garantias inconsistentes.

---

## Key Decisions

- **Contrato agent-native, sem tools de UI por renderer.** O agente escreve por um contrato de objetos e arquivos; renderers consomem esse estado sem exigir `createTable`, `renderKanban` ou equivalentes.
- **Evoluir a sidebar existente.** A árvore, classificação de arquivos, viewers especializados e watchers atuais serão preservados e ampliados, em vez de criar um segundo painel concorrente.
- **Uma identidade canonica, projecoes derivadas.** Objetos terão uma identidade autoritativa; diretórios e manifests serão projeções idempotentes, validadas e reparáveis, sem depender de igualdade frágil entre três fontes.
- **Fundacao antes de views especializadas.** Inbox, calendário e Kanban de objetos serão representações do mesmo modelo, não subsistemas com storage próprio.
- **Integracoes nativas no nucleo.** Gmail e Google Calendar reutilizarão sources/OAuth do Craft; Composio entra como catálogo de long tail, sem gateway comercial ou vínculo com provedor de modelo.
- **Instrucao automatica e contextual.** O contrato de objetos será injetado quando um workspace estruturado estiver ativo, sem carregar permanentemente todo o manual em sessões alheias.
- **Desktop primeiro.** A primeira entrega deve funcionar e ser validada no Electron real; paridade completa com WebUI, viewer e servidor remoto fica fora da fatia inicial.

---

## Actors

- A1. **Usuario do workspace:** cria, navega, filtra e edita objetos e arquivos no Craft Desktop.
- A2. **Agente da sessao:** cria ou altera objetos por contratos documentados e observa o resultado refletido na UI.
- A3. **Runtime Craft:** persiste, valida, projeta, observa e entrega estado consistente ao renderer.
- A4. **Provedor externo:** Gmail, Google Calendar ou Composio entrega dados e OAuth sem expor credenciais ao renderer.

---

## Key Flows

- F1. **Criacao de objeto pelo agente**
  - **Trigger:** A2 recebe um pedido para criar uma tabela, CRM ou board.
  - **Actors:** A2, A3, A1.
  - **Steps:** A2 grava uma mutação estruturada e sua projeção; A3 valida a identidade, publica a mudança e atualiza o conteúdo ativo; A1 vê a nova view sem reiniciar ou pedir outra resposta ao agente.
  - **Covered by:** R1-R6, R10-R12, R24.

- F2. **Navegacao e edicao persistente**
  - **Trigger:** A1 abre um arquivo ou objeto na sidebar e alterna entre conteúdos.
  - **Actors:** A1, A3.
  - **Steps:** O Craft abre ou substitui uma aba preview determinística, resolve o conteúdo com cache e cancelamento, promove a aba ao editar e persiste a mutação antes de revalidar sem flicker.
  - **Covered by:** R7-R15.

- F3. **Conexao e sincronizacao externa**
  - **Trigger:** A1 conecta Gmail, Google Calendar ou um toolkit Composio.
  - **Actors:** A1, A3, A4, A2.
  - **Steps:** OAuth conclui no fluxo seguro existente; A3 registra/testa a source, A2 confirma que as tools estão visíveis e o sync materializa objetos idempotentes e retomáveis.
  - **Covered by:** R17-R23.

- F4. **Mudanca de view por usuario ou agente**
  - **Trigger:** A1 troca o tipo de view ou A2 salva um filtro/segmento.
  - **Actors:** A1, A2, A3.
  - **Steps:** A mesma coleção é projetada para table, Kanban, calendar, timeline, gallery ou list; settings inválidos produzem orientação visível; mutações otimistas confirmam ou revertem.
  - **Covered by:** R13-R16.

---

## Requirements

**Foundation and object contract**

- R1. Cada workspace estruturado deve suportar objetos, campos tipados, entries, valores, relações, statuses, documentos vinculados e histórico de ações sem criar um schema físico por caso de uso.
- R2. O storage deve fornecer uma projeção tabular eficiente e manter um caminho de leitura a partir dos dados normalizados quando a projeção estiver ausente ou stale.
- R3. A identidade do objeto deve ter uma fonte autoritativa, e toda projeção em diretório ou manifest deve ser validada, idempotente e reparável.
- R4. Divergências entre identidade e projeção nunca podem fazer um objeto desaparecer silenciosamente; o sistema deve reparar com segurança ou exibir um erro acionável.
- R5. Inicialização, migrations e seeds devem ser idempotentes e usar identificadores estáveis para objetos de sistema.
- R6. O contrato de escrita usado por A2 deve ser transacional e verificável antes de a UI anunciar a mutação como concluída.

**Preview and reactivity**

- R7. O painel persistente deve evoluir a sidebar direita atual, mantendo árvore de arquivos, viewers especializados, atalhos e comportamento de abrir fora do app quando o tipo não for suportado inline.
- R8. Abas de conteúdo devem ter IDs determinísticos, modos preview/permanente/pinned, restauração escopada por workspace ou sessão e estado ativo sempre válido.
- R9. O resolver de conteúdo deve usar uma união discriminada estrita, cache realmente limitado, stale-while-revalidate, geração por request e cancelamento de cargas iniciais e refreshes.
- R10. Refresh de filesystem deve preservar o conteúdo anterior até o novo estado chegar e nunca permitir que uma resposta stale substitua dados mais recentes.
- R11. Watchers devem ter debounce, ignores para arquivos ruidosos, teardown explícito e isolamento entre workspaces, sessões e clientes.
- R12. A fase inicial deve reutilizar os renderers Craft já suportados; novos tipos entram incrementalmente sem concentrar toda a lógica em um único componente.

**Object views and editing**

- R13. Um único payload de objeto deve alimentar table, Kanban, calendar, timeline, gallery e list sem mudar a fonte de dados ao alternar a view.
- R14. Views salvas devem preservar filtros aninhados, busca, ordenação, visibilidade de colunas e settings específicos, com estado compartilhável e restaurável.
- R15. A tabela deve evoluir de leitura para edição inline por tipo, mantendo validação, relações resolvidas e persistência antes da confirmação visual.
- R16. O Kanban deve agrupar por um campo configurável, oferecer estado vazio acionável e reverter toda mutação otimista que falhar na resposta ou no transporte.

**Integrations, inbox and calendar**

- R17. Integrações devem reutilizar sources, OAuth e credential storage do Craft; tokens e secrets não podem aparecer em config portátil, payload do renderer ou logs.
- R18. Conexões devem passar por teste de source e por um probe ponta a ponta que confirme que A2 enxerga as tools esperadas.
- R19. Gmail sync deve ser idempotente, retomável e rate-limit aware, excluir a própria caixa de contatos e persistir cursores antes de processar cada página.
- R20. O inbox deve classificar remetentes humanos e automatizados, listar apenas previews e hidratar corpo HTML completo sob demanda em superfície sandboxed.
- R21. Calendar sync deve preservar timezone, tratar cancelamentos e recuperar token incremental expirado por full resync seguro.
- R22. A view genérica de calendário deve funcionar para qualquer objeto antes da UI especializada de calendário sincronizado.
- R23. Interações de e-mail e reunião devem alimentar relacionamento por contraparte sem transformar o usuário autenticado em contato.

**Agent guidance and documentation**

- R24. Um workspace estruturado deve ativar automaticamente instruções compactas para criação, relação, projeção e verificação de objetos em todos os backends compatíveis.
- R25. A documentação DenchClaw usada como referência deve ser trazida ao repo e corrigida para distinguir comportamento upstream confirmado, defeitos conhecidos e decisões próprias do Craft.

---

## Acceptance Examples

- AE1. **Covers F1 / R3-R6.** Given um agente cria um objeto e o manifest está ausente, when a transação válida termina, then a projeção é criada ou reparada e o objeto aparece na sidebar sem restart.
- AE2. **Covers F1 / R4.** Given a identidade projetada diverge da fonte autoritativa, when o watcher detecta a mudança, then o Craft repara somente uma projeção segura ou exibe erro acionável sem esconder o objeto.
- AE3. **Covers F2 / R8-R10.** Given o usuário abre mais conteúdos que o limite do cache, when os menos recentes são evictados, then seus payloads deixam a memória e uma aba ativa continua mostrando conteúdo durante revalidação.
- AE4. **Covers F2 / R9.** Given um refresh está em voo, when o usuário troca de aba, then o request anterior é cancelado ou invalidado e sua resposta nunca altera a aba nova.
- AE5. **Covers F2 / R11.** Given um watcher troca de workspace ou perde o último cliente, when o ciclo encerra, then handles e timers são liberados e mudanças do workspace anterior não são emitidas.
- AE6. **Covers F4 / R16.** Given um card muda de coluna, when a persistência falha por resposta ou exceção de rede, then o card retorna à coluna original e o erro fica visível.
- AE7. **Covers F4 / R16.** Given um objeto não possui campo compatível com Kanban, when a view abre, then a UI mostra qual configuração falta em vez de renderizar vazio.
- AE8. **Covers F3 / R17-R18.** Given OAuth conclui, when a source é registrada, then credenciais ficam no store seguro e um probe de sessão confirma as tools sem revelar secrets.
- AE9. **Covers F3 / R19-R20.** Given um backfill Gmail é interrompido após uma página, when ele retoma, then mensagens já materializadas não duplicam e no máximo a página em curso exige reprocessamento.
- AE10. **Covers F3 / R21.** Given o provedor rejeita um token incremental expirado, when o próximo tick roda, then o sync agenda um full resync idempotente em vez de travar permanentemente.

---

## Success Criteria

- A primeira fase entrega storage, projeção validada, tabs/resolver e reatividade usando os renderers atuais do Craft.
- A1 e A2 conseguem criar, abrir e atualizar um objeto no Electron real sem tool de UI específica e sem flicker durante refresh.
- Cache, cancelamento, watcher teardown e projeção têm cobertura focada para os defeitos encontrados no upstream.
- A fundação aceita table, Kanban, calendar, timeline, gallery e list nas fases seguintes sem um novo modelo de dados por renderer.
- Os contratos existentes de preview inline, sources/OAuth, i18n e credenciais continuam verdes e são exercitados no app empacotado ou no runtime Electron equivalente.

---

## Scope Boundaries

**First executable slice**

- Storage estruturado e migrations idempotentes.
- Identidade canonica e projeção validada no filesystem.
- Tabs persistentes, resolver tipado, cache/SWR/cancelamento e watcher reativo.
- Integração com os renderers já existentes no painel direito.

**Deferred to later phases**

- Tabela editável completa, filtros avançados e menu de edição de schema.
- Kanban, calendar, timeline, gallery e list sobre objetos.
- Catálogo Composio, inbox Gmail, calendário sincronizado, perfis e scoring.
- Paridade completa do painel persistente em WebUI, viewer e servidor remoto.

**Outside this roadmap**

- Copiar o gateway comercial Dench Cloud ou condicionar integrações ao modelo selecionado.
- Copiar os 25 renderers e o god-component do DenchClaw de uma vez.
- Reproduzir o runtime de apps `.dench.app` e sua bridge de permissões nesta change.
- Injetar milhares de linhas de skills em toda sessão, independentemente do workspace.

---

## Dependencies and Assumptions

- O contrato existente de preview inline em `openspec/specs/audio-preview-and-markdown/spec.md` continua válido e deve ser estendido, não substituído.
- O fluxo de sources/OAuth em `openspec/specs/workspace-and-sources/spec.md` continua sendo a autoridade para credenciais e isolamento por workspace.
- A escolha do engine estruturado foi resolvida no planejamento: o adapter SQLite
  cross-runtime existente é a autoridade canônica em macOS, Windows e Linux;
  DuckDB permanece apenas como referência upstream.
- A implementação inicial é local-first e Electron-first; a camada de domínio deve evitar dependência do renderer para permitir paridade posterior.

---

## Deferred to Planning

- Histórico resolvido: a comparação SQLite versus DuckDB resultou em SQLite
  canônico com projeção tabular reconstruível mantida pela aplicação.
- Definir a fronteira entre estado no workspace visível ao agente e estado app-scoped controlado pelo runtime.
- Dividir o roadmap em changes OpenSpec ou fases auditáveis sem sobrepor changes ativas do preview e de credenciais.
- Definir o limite do cache, a política de persistência das tabs e os eventos RPC/IPC necessários.
- Decidir quais tipos de campo terão storage tipado desde a primeira migration e quais serão adicionados depois.

---

## Sources and Research

- `openspec/changes/harden-right-sidebar-inline-preview/` documenta e testa a sidebar com árvore e preview inline já existente.
- `openspec/specs/audio-preview-and-markdown/spec.md` é o contrato vigente de classificação e routing de preview.
- `openspec/specs/workspace-and-sources/spec.md` é o contrato vigente de workspace, source, OAuth e credential storage.
- `packages/shared/src/views/storage.ts`, `packages/shared/src/tasks/storage.ts` e `packages/shared/src/config/watcher.ts` fornecem padrões locais de persistência validada, escrita atômica e reatividade.
- `apps/electron/src/renderer/components/right-sidebar/SessionFilesSection.tsx` e `apps/electron/src/renderer/components/app-shell/right-sidebar-preview-state.ts` são as superfícies atuais a evoluir.
- [DenchClaw upstream](https://github.com/DenchHQ/DenchClaw/tree/f14eb4c239002d7b28673c60955b689b9d69db22) foi inspecionado nesse commit; EAV, PIVOT com fallback, tabs, SWR, watcher e renderers foram confirmados.
- A inspeção upstream refutou o limite efetivo do cache, qualificou o cancelamento de refresh, reduziu o triple alignment a uma projeção parcialmente reparável e encontrou 12 skills marcadas para injection.
