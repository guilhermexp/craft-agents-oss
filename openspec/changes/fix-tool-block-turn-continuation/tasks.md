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
