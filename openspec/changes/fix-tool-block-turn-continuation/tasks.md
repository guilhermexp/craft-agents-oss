## 1. Teste vermelho primeiro

- [x] 1.1 Reescrever `packages/shared/src/agent/__tests__/claude-tool-block-encoding.test.ts` para o
      contrato novo: bloqueio de prerequisite não pode produzir `continue: false`. Rodar e registrar
      o run VERMELHO contra o código atual.

## 2. Dispatcher sinaliza a intenção

- [x] 2.1 Adicionar `endTurn?: boolean` à variante `block` de `ToolPermissionResult` em
      `packages/shared/src/agent/core/tool-permission-dispatcher.ts`, documentando que só a negação
      explícita do usuário a usa.
- [x] 2.2 Marcar `endTurn: true` apenas no retorno `'Permission denied by user.'`.

## 3. Encoder do backend Claude

- [x] 3.1 `blockWithReason` em `packages/shared/src/agent/mode-manager.ts` passa a devolver
      `{ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision:
      'deny', permissionDecisionReason: '[ERROR] ' + reason } }`.
- [x] 3.2 `encodeClaudeToolBlock` em `packages/shared/src/agent/claude-agent.ts` devolve `deny` +
      turno vivo no caminho normal e `{ continue: false, decision: 'block', reason, stopReason }`
      quando `endTurn`.
- [x] 3.3 Conferir `lsp references`/grep de `blockWithReason` e ajustar todos os callsites
      (`claude-agent.ts` AskUserQuestion + guarda de imagem).

## 4. Turno sem resposta nunca é silencioso

- [x] 4.1 Em `packages/server-core/src/sessions/SessionManager.ts`, garantir que o caminho
      "completed without assistant response" sempre termina numa mensagem visível: erro 400
      preservado, senão mensagem genérica com retry habilitado.

## 5. Testes e gates

- [x] 5.1 `bun test packages/shared/src/agent/__tests__/claude-tool-block-encoding.test.ts` VERDE.
- [x] 5.2 Cobrir `endTurn` em `packages/shared/src/agent/core/__tests__/tool-permission-dispatcher.test.ts`
      (`runPreToolUseChecks` não emite `endTurn`, então `pre-tool-use-checks.isolated.ts` não é o lugar;
      permanece como gate de regressão).
- [x] 5.3 `bun run typecheck:shared` e `cd packages/server-core && bun run tsc --noEmit`.
- [x] 5.4 `openspec validate fix-tool-block-turn-continuation --strict --no-interactive`.
- [x] 5.5 Suíte completa `bun test` uma vez no fim.

## 6. DOX

- [x] 6.1 Atualizar `packages/shared/CLAUDE.md` com o contrato de bloqueio do backend Claude.

## 7. Correções da revisão (segunda rodada)

- [x] 7.1 Guardar o branch genérico do `SessionManager` contra parada intencional:
      `shouldReportMissingAssistantResponse()` exportada como seam puro, negando
      `stopRequested`, `wasInterrupted` e fila de mensagens não vazia (cobre Stop e Redirect).
- [x] 7.2 Teste vermelho→verde em `packages/server-core/src/sessions/no-response-guard.test.ts`.
- [x] 7.3 `PrerequisiteManager.beginTurn()` re-arma só `rejectionCounts`, chamado no início de
      `BaseAgent.chat()`; `readFiles`/`pendingSkillPaths` seguem com vida de sessão.
- [x] 7.4 `MAX_REJECTIONS = 3`, com a justificativa da nova semântica registrada no proposal.
- [x] 7.5 Braço de skills libera apenas o path cobrado (o mais antigo pendente) em vez de
      `pendingSkillPaths.clear()`.
- [x] 7.6 Ampliar `packages/shared/src/agent/core/__tests__/prerequisite-manager.isolated.ts`:
      duas chamadas no mesmo turno não liberam, re-arme por turno, liberação de um path só.
      Registrar o run VERMELHO antes do fix e o VERDE depois.
- [x] 7.7 `encodeClaudeToolBlock(result, steerContext?)` propaga o steer no deny; `canDeliverSteer()`
      decide quem entrega. O ramo `endTurn` não consome o steer (`steer_undelivered` re-enfileira).
- [x] 7.8 Cobrir 7.7 em `packages/shared/src/agent/__tests__/claude-tool-block-encoding.test.ts`.
- [x] 7.9 Corrigir o comentário do invariante `endTurn` em `tool-permission-dispatcher.ts`: negação
      no prompt vinda de usuário, cleanup (`clearPendingPermissions`) ou fail-closed do broker.
- [x] 7.10 DOX: atualizar `packages/shared/CLAUDE.md` com o contrato do prerequisite por turno e a
      entrega do steer no deny.

## 8. Correções da revisão (terceira rodada)

- [x] 8.1 `shouldReportMissingAssistantResponse` passa a receber a `ManagedSession` e a suprimir
      só em interrupção real (`stopRequested` ou `wasInterrupted`), com a detecção factual
      "este turno respondeu?" via `turnStartFinalMessageId` no lugar da cláusula de fila.
- [x] 8.2 O push mid-stream só marca `wasInterrupted` quando `behavior === 'steer'` (todo
      `redirect()` falso já chamou `forceAbort`); `case 'steer_undelivered'` deixa de marcar.
- [x] 8.3 `withUndeliveredSteer()` emite `steer_undelivered` antes do `complete`; `chatImpl` vira
      o wrapper sobre `runChatTurn` e o `yield` no `finally` sai.
- [x] 8.4 `PrerequisiteManager.releasedPaths` com vida de sessão, consultado antes de cobrar o
      orçamento e limpo só por `resetReadState()`.
- [x] 8.5 `no-response-guard.test.ts` → `no-response-guard.isolated.ts` no nível do call site,
      com estado montado pelos caminhos de produção. RED antes / GREEN depois.
- [x] 8.6 Cobertura RED→GREEN de 8.3 em `claude-tool-block-encoding.test.ts` (ordem antes do
      `complete`, turno sem `complete`, e o controle que prova que um `yield` em `finally` é
      descartado pelo mesmo consumidor).
- [x] 8.7 Cobertura RED→GREEN de 8.4 em `prerequisite-manager.isolated.ts`: concessão não é
      recobrada no turno seguinte, orçamento não concedido continua re-armando, `strict` nunca é
      concedida, compactação re-arma a concessão.
- [x] 8.8 DOX: `packages/shared/CLAUDE.md` (itens de steer, prerequisite e turno sem resposta) e
      spec deltas de `agent-backends` / `session-management` atualizados para o contrato real.
