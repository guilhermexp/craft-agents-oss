## Why

Uma revisão de arquitetura (2026-07-25) percorreu o monorepo procurando
**módulos rasos** — módulos cuja interface é quase tão complexa quanto a
implementação — e encontrou onze pontos de atrito, além de seis defeitos
verificados que são sintoma direto deles.

Três dos onze são decisões OpenSpec **arquivadas e aplicadas pela metade**:

1. `2026-05-11-split-session-manager-by-domain` dimensionou as extrações em
   3.700/900/800 linhas. O que existe é 72/118/167, e `SessionManager.ts`
   **cresceu de 7.572 para 9.305 linhas** durante a change.
   `SessionLifecycleManager` é construído com 12 callbacks
   (`SessionManager.ts:1425-1438`) e **nunca é chamado**.
2. `2026-05-11-flatten-rpc-handlers-to-protocol-adapters` valeu em 5 dos 6
   handlers. Falhou no maior: `handlers/rpc/hermes.ts` tem 1.614 linhas e
   **80% do corpo dos handlers é comportamento**, não tradução de transporte.
3. `2026-07-15-harden-browser-agentic-security` F1.2 registra que o gate
   `allowRemoteEvaluate` existia só no dispatcher e o caminho local passava por
   baixo. A correção **duplicou o gate** em vez de unificar o seam.

Os seis defeitos verificados que já estão em produção:

1. `list_background_tasks` é anunciado no system prompt como *"the ONLY
   reliable way to answer what is running"* (`prompts/system.ts:999`) mas não
   tem entrada `defineTool` — não está em catálogo nenhum e **nenhum backend
   consegue chamá-lo**.
2. O `call_llm` do Claude omite `thinking`/`thinkingBudget` que o contrato v1
   declara (`tool-defs.ts` tem `thinkingBudget`, `llm-tool.ts` não tem).
3. O `spawn_session` do Claude aceita `projectId`, que `SpawnSessionSchema` não
   declara (em `tool-defs.ts` a palavra só aparece na prosa de outro tool).
4. O Pi executa registry tools via `def.handler(ctx, args)`
   (`pi-agent.ts:1655-1662`), pulando `executeSessionTool` — **sem validação de
   input nem de output no caminho Pi**.
5. Uma árvore stale e gitignorada em `apps/electron/packages/shared/`
   **sombreia** o interceptor canônico em runs de dev: `resolveUpwards` testa o
   nível 0 primeiro (`runtime-resolver.ts:52-62,202-206`), e a cópia está 694
   linhas atrás, sem `CRAFT_DEBUG_SSE_RAW`.
6. Código morto com aparência de sistema-de-registro: `SessionLifecycleManager`
   (0 chamadores), `ToolPermissionDispatcher` (0 importadores),
   `sources/credential-strategies/` (804 linhas, 6 adapters, 0 chamadores),
   `StoredConfig.migrationsApplied` (1 referência = a própria declaração),
   `drivers/pi.ts:318` (byte-equivalente ao fallback do framework).

O custo não é estético. Cada um desses pontos já produziu divergência
observável: o gate de segurança duplicado, três violações v1 vivas, e quatro
cópias do mapa `authType → credencial` que **discordam entre si**.

## What Changes

Onze slices, em três ondas. Cada slice move um seam ou o remove; nenhum
introduz um seam novo sem dois adapters reais.

### Onda 1 — defeitos, código morto e deepenings pequenos

- **session-tools-mcp** — `defineTool` vira a única declaração também para
  backend-mode tools. Os adapters Claude (`spawn-session-tool.ts`,
  `llm-tool.ts`, `browser-tools.ts`) passam a derivar descrição e schema do
  catálogo canônico em vez de reescrevê-los; sobra neles só o corpo de
  execução. Corrige os defeitos 1–4. `projectId` é **adicionado** ao
  `SpawnSessionSchema` (direção segura para v1 — o Claude já aceita hoje;
  removê-lo seria quebra). O checker passa a partir de coisas **ainda não
  registradas**, para conseguir detectar bypass.
- **agent-backends** — a orquestração PreToolUse, hoje duplicada inline em
  Claude e Pi e **já divergida em quatro comportamentos**, passa a usar o
  `ToolPermissionDispatcher` que já existe e está morto. Cada backend fornece
  só o encoder de resposta do seu SDK.
- **credential-storage** — `CredentialManager` ganha um resolvedor que devolve
  **valor** ao lado do preditor `hasLlmCredentials`, que só devolve boolean e
  descarta o valor que acabou de buscar (`manager.ts:545-548`). As três
  re-derivações do mesmo mapa colapsam. `credential-strategies/` e
  `drivers/pi.ts:318` são deletados.
- **hermes-embed** — a resolução do interceptor deixa de ser busca ascendente
  que pode casar dentro de `apps/electron/packages/`.
- **hermes-dashboard-host** — `HermesRuntimeManager` sai de dentro do arquivo
  de handler e ganha os métodos que o design arquivado já nomeou.
- **settings-and-config** — a decisão "qual artefato é este, qual schema se
  aplica", hoje codificada quatro vezes, vira uma tabela. A lista de fases de
  migration deixa de ser comentários e vira dados com id.

### Onda 2 — módulos grandes

- **session-management** — completa o split arquivado: store vira dono único
  da persistência (66 sites), publisher vira dono único da emissão (114
  sites), `SessionLifecycleManager` é deletado.
- **protocolo** — os mesmos fatos deixam de ser declarados quatro vezes
  (`RPC_NAMESPACES` 388 folhas, `ElectronAPI` 589 linhas, `CHANNEL_MAP` 357
  entradas, 24 arrays `HANDLED_CHANNELS`); tudo passa a derivar de um contrato
  tipado. Os dois testes de paridade e a lista de exclusão de 14 nomes somem.
- **browser panes** — o vocabulário restado cinco vezes colapsa;
  `BrowserPaneFns` vira a interface única voltada ao agente e
  `IBrowserPaneManager` desce para o seam de transporte que já é. O pane
  manager ganha seams internos para as preocupações que os testes já cutucam
  com `as any` (68 vezes).
- **messaging-gateway** — o registry para de reabrir o seam de plataforma.

### Onda 3 — renderer

- **Turn projection** — a projeção ganha uma casa: uma identidade de Turn, um
  cache, uma polaridade de expansão.
- **AppShellContext** — o bag de 65 campos com um adapter só é quebrado por
  substantivo de domínio.

**Não-objetivos**: mudar nome, input, output ou contrato de erro de qualquer
tool v1 público; trocar o backend de credenciais default; reabrir F4.1 do
`harden-credential-storage`; tocar em `apps/electron/scripts/.hermes-cache/`.

## Impact

- Specs afetadas: `session-tools-mcp`, `agent-backends`, `credential-storage`,
  `hermes-embed`, `hermes-dashboard-host`, `session-management`,
  `settings-and-config`, `messaging-gateway`, `workspace-and-sources`.
- Áreas saudáveis explicitamente fora de escopo: `event-processor/processor.ts`,
  o núcleo de derivação de `turn-utils.ts`, `browser-tool-runtime.ts`,
  `browser-cdp.ts`, `hermes/auth-bridge.ts`, `auth/oauth.ts`,
  `config/watcher.ts`, `dto.ts`, `agent/native/`, `powershell-validator.ts` e
  toda a slice de War Room channels — onde a decisão de flatten valeu como
  escrita.
- Um tool passa a existir para os agentes que já eram instruídos a chamá-lo
  (`list_background_tasks`); dois inputs v1 declarados passam a funcionar no
  Claude; o caminho Pi passa a validar. O golden precisa ser regerado.
