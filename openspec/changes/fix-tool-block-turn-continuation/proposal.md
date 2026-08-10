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

## Correções da revisão (terceira rodada)

Uma segunda revisão independente sobre `217d7b1c..20691bf4` deu NO-GO com quatro achados. Todos
são consequência da primeira rodada de correções, não do desenho original.

### 5. A guarda de `No Response` escondia exatamente o bug que a change existe para expor

`shouldReportMissingAssistantResponse()` suprimia a mensagem com
`stopRequested || wasInterrupted || queuedMessageCount > 0`. Isso consertou o falso positivo do
Stop e criou um falso negativo pior: o site de push mid-stream marcava `wasInterrupted = true`
para as **duas** formas de mensagem, inclusive `behavior === 'queue'` — que é o **padrão das
conexões `anthropic`** e que, pelo próprio comentário do código, não chama `agent.redirect()`, não
chama `forceAbort` e não interrompe nada. Qualquer usuário que digitasse durante um turno Claude
deixava a sessão com `wasInterrupted` marcado e fila não vazia num turno que ninguém interrompeu;
se esse turno morresse calado — tool recusada sem texto do assistente — o card sumia, e a mensagem
enfileirada virando turno novo tornava a morte do turno original invisível.

Rota escolhida: **(b) cirúrgica**, com o sinal factual da rota (a) no lugar da cláusula removida.

- `wasInterrupted` volta a significar *o turno foi abortado*. No push mid-stream só é marcado
  quando `behavior === 'steer'`: todo `redirect()` que devolve `false` já chamou
  `forceAbort(AbortReason.Redirect)` (`BaseAgent`, `ClaudeAgent` e `PiAgent`), então esse ramo é o
  único onde houve abort de verdade. Em `queue` nada é abortado.
- O segundo consumidor de `wasInterrupted` (`:6301`, nota de contexto "a resposta anterior foi
  interrompida") estava errado no caminho `queue` pelo mesmo motivo — o turno anterior completou
  naturalmente. A mesma correção conserta os dois, que é o tratamento coerente pedido.
- `case 'steer_undelivered'` também deixa de marcar `wasInterrupted`: ele não aborta nada, o turno
  já tinha acabado (tipicamente pela negação no prompt de permissão) e o evento só devolve a
  mensagem. Marcar ali silenciava o card justamente no turno que morreu sem dizer nada.
- A cláusula `queuedMessageCount === 0` sai do predicado. Para não trocar um falso negativo por um
  falso positivo novo, a detecção "este turno respondeu?" passa a ser factual: `turnStartFinalMessageId`
  (setado no início do turno, limpo só em `onProcessingStopped`, depois desta avaliação) comparado
  com a última mensagem final do assistente. A comparação de timestamps do call site sozinha
  acusaria um turno que respondeu, porque a mensagem mid-stream do usuário é mais nova que o texto
  daquele mesmo turno.
- O seam passa a receber a `ManagedSession` em vez de flags soltas. Quais sinais o call site
  encaminha, e se estão setados naquele instante, era exatamente o ponto cego da rodada anterior.

### 6. `steer_undelivered` era código morto — a mensagem do usuário sumia

O `yield` de `steer_undelivered` estava dentro do `finally` de `chatImpl`. O consumidor
(`SessionManager.sendMessage`) sai do `for await` no primeiro `complete`, e todo caminho terminal
emite `complete` antes; um `yield` alcançado por `iterator.return()` é **descartado** pelo laço
abandonado. `case 'steer_undelivered'` nunca rodava e a mensagem mid-turn do usuário era perdida
quando a negação no prompt de permissão encerrava o turno. O comentário do hook, o
`packages/shared/CLAUDE.md` e o cenário no spec afirmavam o contrário.

`withUndeliveredSteer(turn, takePendingSteer)` — exportado de `claude-agent.ts` — envolve o
gerador do turno e emite `steer_undelivered` **antes** do `complete`, e também quando o turno
termina sem `complete` (restart de source activation). `chatImpl` vira esse wrapper sobre
`runChatTurn` (o corpo anterior, renomeado); o `yield` no `finally` sai. Não é mudança
arquitetural no canal de eventos: nenhum tipo de evento muda, nenhum buffer novo atravessa
camadas, e o consumidor é o mesmo.

### 7. O teste da guarda cimentava o defeito

`no-response-guard.test.ts` era a tabela-verdade literal do predicado — nenhum bug plausível o
quebrava, e um dos casos afirmava como desejado exatamente o comportamento errado do item 5. Ele é
substituído por `no-response-guard.isolated.ts`, no nível do call site: `ManagedSession` real,
estado produzido pelos caminhos de produção (`sendMessage` mid-stream em `queue` e em `steer`, e o
evento `steer_undelivered` via `dispatchAgentEvent`), e a guarda chamada com essa sessão como o
branch de `complete` faz. Isolado porque `CONFIG_DIR` é resolvido no load do módulo de config e é
a conexão que decide steer-vs-queue — mesmo padrão de `resolve-supports-branching.isolated.ts`.

### 8. O escape hatch do prerequisite virou pedágio recorrente

`beginTurn()` limpa `rejectionCounts` sem registrar que um path já foi concedido, então para a
condição permanente que justifica o escape existir (guia ilegível, arquivo sumiu depois do
`existsSync`, Read desabilitado) o modelo pagava `MAX_REJECTIONS` tool calls bloqueadas no início
de **cada** turno, para sempre. Antes de `20691bf4` o escape era vitalício de sessão.

`releasedPaths: Set<string>` com vida de sessão (limpo só por `resetReadState()`) é consultado
antes de cobrar o orçamento e preenchido na concessão. As duas propriedades que já valiam ficam de
pé: orçamento **gasto e não concedido** não atravessa turno, e regra `strict` nunca é liberada —
ela retorna antes do fallback, então nunca entra no set.

### Impacto adicional

- Código afetado, além do já listado: `packages/server-core/src/sessions/no-response-guard.isolated.ts`
  (substitui `no-response-guard.test.ts`).
- Sem mudança de contrato RPC, de `AgentEvent` ou de tipos compartilhados. `shouldReportMissingAssistantResponse`
  é exportada só como seam de teste e não atravessa pacote.

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
