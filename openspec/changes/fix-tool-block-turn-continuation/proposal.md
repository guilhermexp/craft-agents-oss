## Why

Log de runtime real (sessão `260727-still-brook`, 2026-08-09 23:03:03 UTC): o modelo chamou
`mcp__session__browser_tool` sem ter lido o guia exigido pelo `PrerequisiteManager`. O
`PrerequisiteManager` bloqueou corretamente — e o turno inteiro morreu:

```
23:03:03.363 [session] Prerequisite blocked (strict): mcp__session__browser_tool requires .../browser-tools.md
23:03:03.364 [session] Tool blocked by permission mode Object
23:03:03.380 [session] SDK message: user (tool_result for null)
23:03:03.381 [session] <<< TOOL DONE: mcp__session__browser_tool (toolu_017VEE...) isError=true
23:03:03.657 [session] stream_event: message_stop
23:03:03.672 [session] Session 260727-still-brook completed without assistant response - possible context overflow or API issue
```

Zero texto do assistente, zero recuperação, nada na UI além de um card de tool vermelho. Não foi
context overflow nem erro de API — o warning é enganoso.

Causa raiz: o hook `PreToolUse` do backend Claude devolve `continue: false` em **todo** bloqueio.
No Claude Agent SDK `continue: false` encerra o loop do agente depois do hook — bloqueia a tool
**e** mata o turno.

- `packages/shared/src/agent/mode-manager.ts` — `blockWithReason()` retorna `{ continue: false, decision: 'block', reason: '[ERROR] ' + reason }`.
- `packages/shared/src/agent/claude-agent.ts` — `encodeClaudeToolBlock()`: ramo `isError` delega a `blockWithReason`; ramo control-flow retorna `{ continue: false, decision: 'block', reason }`.
- `blockWithReason` também é chamado direto na validação de args do `AskUserQuestion` e na guarda de imagem >5MB.

A prova de que `continue:false` nunca foi a intenção está no bloco de **sucesso** da ativação de
source (`tool-permission-dispatcher.ts`), que instrui o modelo a `"Respond to the user now: tell
them the source is now active and ask them to send their request again."` — hoje impossível,
porque o modelo é desligado antes de poder responder.

A API correta já existe no SDK e não é usada em lugar nenhum do repo:
`PreToolUseHookSpecificOutput { permissionDecision, permissionDecisionReason }` com
`HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'`.

Além disso, o `SessionManager` só empurra mensagem para a UI num turno sem resposta quando existe
um `apiError.status === 400`; qualquer outro caso vira só um `sessionLog.warn` e o usuário fica
sem nada na tela.

## What Changes

Contrato de comportamento: **o turno só termina quando um humano o terminou.** Toda negação de
tool devolve o motivo ao modelo e mantém o turno vivo, para o modelo corrigir e seguir. A única
exceção é a negação explícita do usuário num prompt de permissão.

- **Dispatcher** — a variante `block` do `DispatchResult` ganha `endTurn?: boolean`. Só a negação
  do usuário no prompt de permissão (`'Permission denied by user.'`) a marca.
- **Encoder do backend Claude** — o caminho normal passa a devolver
  `{ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: <reason> } }`. Só `endTurn` mantém `{ continue: false, decision: 'block',
  reason }`, agora com `stopReason` preenchido.
- **Marcador `[ERROR]`** — preservado: quando `isError`, o prefixo `[ERROR] ` continua no texto que
  chega ao modelo, agora dentro de `permissionDecisionReason`. Contrato coerente com
  `packages/session-tools-core/src/response.ts` e `packages/ui/src/components/chat/turn-utils.ts`.
- **Turno sem resposta nunca mais é silencioso** — o `SessionManager` sempre termina esse caminho
  numa mensagem visível: erro 400 capturado mantém o comportamento atual; caso contrário emite uma
  mensagem genérica de turno encerrado sem resposta, com retry habilitado.

## Impact

- Affected specs: `agent-backends`, `session-management`
- Affected code: `packages/shared/src/agent/core/tool-permission-dispatcher.ts`,
  `packages/shared/src/agent/claude-agent.ts`, `packages/shared/src/agent/mode-manager.ts`,
  `packages/server-core/src/sessions/SessionManager.ts`, testes correspondentes,
  `packages/shared/CLAUDE.md`.
- Backend Pi intocado: usa `tool_execute_response`, caminho diferente e sadio.
- `PrerequisiteManager` intocado: a política `strict` está correta; o bug é o encoding do bloqueio.
- Sem mudança de contrato RPC ou de tipos compartilhados (`AgentEvent` não muda). O `stop_reason`
  do `result` do SDK não é plumbado até o `SessionManager`: isso exigiria campo novo atravessando
  `packages/core/src/types/message.ts`, o adapter de eventos do Claude e o `SessionManager`.
