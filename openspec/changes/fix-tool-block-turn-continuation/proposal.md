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

## Correções da revisão (segunda rodada)

Duas revisões independentes sobre o diff de `217d7b1c` apontaram três defeitos e um comentário
inexato. Todos são consequência de o turno agora continuar vivo depois de um bloqueio.

### 1. `No Response` disparava em parada intencional do usuário

`cancelProcessing` marca `stopRequested`/`wasInterrupted` e **não** limpa `isProcessing` — de
propósito, para o loop drenar os eventos em vôo. O evento `complete` então chega ao branch novo com
`isProcessing === true`, e o usuário que aperta Stop antes de qualquer texto do assistente via o
info "Response interrupted" **mais** um card vermelho "No Response" com retry. Mesmo efeito no
redirect (`forceAbort(AbortReason.Redirect)`), que enfileira a mensagem e corta o turno.

O branch genérico passa a ser guardado por `shouldReportMissingAssistantResponse()`, função pura
exportada do `SessionManager` (o branch em si exige um turno real do SDK; a função é o seam de
teste). Ela só reporta quando a mensagem não é intencional: sem `stopRequested`, sem
`wasInterrupted` e sem mensagem na fila esperando replay. O caminho de erro 400 capturado não muda.

### 2. `MAX_REJECTIONS` virou auto-bypass dentro do mesmo turno

`MAX_REJECTIONS = 1` foi calibrado quando **um bloqueio encerrava o turno**: a segunda chamada da
mesma tool exigia o usuário reenviar a mensagem. Com o turno vivo o modelo emite as duas chamadas
sozinho e passa pelo prerequisite sem ninguém no circuito — e `rejectionCounts` só zerava em
`resetReadState()` (compactação/`clearHistory`), então o contador atravessava turnos.

- `PrerequisiteManager.beginTurn()` re-arma **só** `rejectionCounts`, chamado no início de
  `BaseAgent.chat()` (vale para Claude e Pi). `readFiles` e `pendingSkillPaths` continuam com vida
  de sessão: quem os derruba é a compactação, via `resetReadState()`.
- `MAX_REJECTIONS = 3`. Justificativa de por que não é bypass barato: o orçamento é **por turno** e
  o modelo que cumpre a regra gasta exatamente um bloqueio — ele recebe o motivo e lê o arquivo no
  mesmo turno. O escape existe para o modelo que **não consegue** cumprir (guia ilegível, sumiu
  depois do `existsSync`, Read desabilitado): negar para sempre queimaria o turno inteiro num loop
  de tool call sem texto nenhum — exatamente a falha que esta change remove. Três bloqueios dão
  espaço para uma leitura falha mais uma tentativa antes de conceder, e o contador não sobrevive ao
  turno. Regras `strict` (docs do browser) não chegam ao fallback.
- O braço de skills nunca mais faz `pendingSkillPaths.clear()`. O orçamento é cobrado de **um** path
  pendente (o mais antigo, o primeiro listado no motivo do bloqueio); ao esgotar, só ele é liberado
  e os demais continuam guardando o turno. Insistir numa skill não derruba mais o read-before-execute
  de todas as outras pelo resto da sessão.

### 3. Mensagem de steer descartada em silêncio no caminho de bloqueio

O hook consumia `pendingSteerMessage` antes do `switch`, mas só `allow`/`modify` reanexavam via
`additionalContext`; o ramo `block` chamava `encodeClaudeToolBlock()`, que não carregava contexto
nenhum. Com o campo já zerado o fallback `steer_undelivered` também não disparava. A perda é
anterior a `217d7b1c`, mas o commit a torna comum: o turno segue vivo por N tool calls.

`PreToolUseHookSpecificOutput` aceita `additionalContext` junto de `permissionDecision`, então o
deny passa a entregar o steer. `canDeliverSteer()` decide quem pode carregá-lo: todo desfecho que
mantém o turno vivo (`allow`, `modify`, `passthrough`, `block` sem `endTurn`). No `endTurn` o steer
**não** é consumido — o loop morre logo depois do hook, e deixá-lo pendente é o que faz o `finally`
do `chatImpl` emitir `steer_undelivered` para a mensagem ser re-enfileirada.

### 4. Invariante documentado do `endTurn`

O comentário afirmava que só uma negação explícita do usuário seta `endTurn`. Duas rotas
programáticas resolvem o mesmo prompt como negado: `clearPendingPermissions()` (forceAbort/destroy,
onde o turno já está morrendo) e a rejeição fail-closed do broker em `respondToPermission`. Nenhuma
é regressão — comportamento idêntico ao da `main`. O comentário passa a dizer isso.

## Impact

- Affected specs: `agent-backends`, `session-management`
- Affected code: `packages/shared/src/agent/core/tool-permission-dispatcher.ts`,
  `packages/shared/src/agent/claude-agent.ts`, `packages/shared/src/agent/mode-manager.ts`,
  `packages/shared/src/agent/core/prerequisite-manager.ts`,
  `packages/shared/src/agent/base-agent.ts`,
  `packages/server-core/src/sessions/SessionManager.ts`, testes correspondentes,
  `packages/shared/CLAUDE.md`.
- Backend Pi: o encoding do bloqueio não muda (usa `tool_execute_response`), mas o re-arme por turno
  do `PrerequisiteManager` vale para ele também, porque mora em `BaseAgent.chat()`.
- `PrerequisiteManager`: a política `strict` (docs do browser) continua intocada e imune ao
  fallback; o que muda é a calibragem do escape hatch não-strict, agora por turno.
- Sem mudança de contrato RPC ou de tipos compartilhados (`AgentEvent` não muda). O `stop_reason`
  do `result` do SDK não é plumbado até o `SessionManager`: isso exigiria campo novo atravessando
  `packages/core/src/types/message.ts`, o adapter de eventos do Claude e o `SessionManager`.
