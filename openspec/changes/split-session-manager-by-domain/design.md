## Contexto Atual

`SessionManager.ts` possui 7.572 linhas. A classe `SessionManager` começa por volta da linha 1.131 e concentra aproximadamente 6,4 mil linhas de lógica runtime. A leitura do arquivo e do handler RPC mostrou esta distribuição aproximada:

- Lifecycle/runtime de sessão: cerca de 3.700 a 4.200 linhas. Inclui `createSession`, branch, criação/restauração de backend, callbacks de agente, `sendMessage`, cancelamento, delete, automações e transfer/import/export.
- Store/persistência de mensagens: cerca de 650 a 900 linhas diretas, mais chamadas espalhadas. Inclui `loadSessionsFromDisk`, `persistSession`, `flushSession`, lazy load de mensagens, update de conteúdo/anotações, truncamento implícito e persistência de sidecars de branch.
- Event publishing/IPC para renderer/CLI: cerca de 800 a 1.000 linhas. Inclui `sendEvent`, batching de deltas, broadcasts, `processEvent` e eventos de tool/text/status/error/usage.
- File watching e sincronização por filesystem: cerca de 350 a 450 linhas somando `setupConfigWatcher`, `notifyConfigFileChange`, reload de sources e o watcher por cliente em `handlers/rpc/sessions.ts`.
- Artifact rendering de Mermaid/SVG: cerca de 175 linhas hoje no topo de `handlers/rpc/sessions.ts`, acionadas por `GET_FILES`.
- IPC/processos de agente e runtime-specific callbacks: cerca de 1.400 a 1.800 linhas dentro de `getOrCreateAgent`, handlers de auth/permissão/source activation/spawn session, background tasks e shell/process kill.

Essas contagens são aproximadas porque os métodos longos misturam persistência, evento, runtime e lifecycle no mesmo bloco. Essa mistura é justamente o problema que a change deve resolver.

## Shape dos Submódulos

### `SessionMessageStore`

Responsabilidade: ser o único dono de leitura/escrita persistida de sessão e mensagens.

Interface pública proposta:

```ts
interface SessionMessageStore {
  listMetadata(workspaceRootPath: string): StoredSessionMetadata[]
  load(sessionId: string): Promise<StoredSession | null>
  ensureMessagesLoaded(session: ManagedSession): Promise<void>
  appendMessage(session: ManagedSession, message: Message): Promise<void>
  updateMessage(session: ManagedSession, messageId: string, patch: Partial<Message>): Promise<void>
  truncateAfter(session: ManagedSession, messageId: string): Promise<void>
  persist(session: ManagedSession): void
  flush(sessionId: string): Promise<void>
  flushAll(): Promise<void>
}
```

Regras:

- Não publica eventos.
- Não cria backend.
- Não conhece renderer, CLI, Mermaid ou watcher.
- Mantém a semântica append-only sempre que possível; rollback/truncate deve ser operação explícita e auditável.

### `SessionEventPublisher`

Responsabilidade: publicar eventos de sessão e workspace para renderer/CLI com ordenação, batching e deduplicação.

Interface pública proposta:

```ts
interface SessionEventPublisher {
  setSink(sink: EventSink): void
  publish(event: SessionEvent, workspaceId: string): void
  queueTextDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void
  flushTextDelta(sessionId: string, workspaceId: string): void
  publishWorkspaceChanged(kind: WorkspaceSessionEventKind, workspaceId: string, payload?: unknown): void
  cleanupSession(sessionId: string): void
  cleanup(): void
}
```

Regras:

- Não persiste mensagens.
- Não interpreta lifecycle além do necessário para ordering/delta batching.
- Centraliza canais RPC e evita `eventSink` espalhado por lifecycle, store e renderer de artefatos.

### `SessionArtifactRenderer`

Responsabilidade: derivar artefatos renderizados a partir do histórico persistido, sem entrar no caminho crítico de envio de mensagem.

Interface pública proposta:

```ts
interface SessionArtifactRenderer {
  syncSessionArtifacts(sessionPath: string): Promise<void>
  renderMermaidFromSession(sessionPath: string): Promise<ArtifactRenderResult>
  scanSessionFiles(sessionPath: string): Promise<SessionFile[]>
}
```

Regras:

- Extração de Mermaid, geração de SVG e limpeza de fontes visíveis ficam fora do handler RPC.
- Renderização deve ser assíncrona e rate-limited por sessão para `GET_FILES` ou watcher não saturarem CPU/IO.
- Falha de Mermaid deve degradar para "sem artefato gerado", sem afetar lifecycle, persistência ou streaming.
- Arquivos derivados devem continuar distinguíveis de arquivos editáveis do usuário.

### `SessionLifecycleManager`

Responsabilidade: orquestrar operações de sessão e coordenar store, runtime e publisher.

Interface pública proposta:

```ts
interface SessionLifecycleManager {
  initialize(): Promise<void>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  getSession(sessionId: string): Promise<Session | null>
  getSessions(workspaceId?: string): Session[]
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  rollbackToMessage(sessionId: string, messageId: string, confirmed: true): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>
  importSession(workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<ImportSessionResult>
}
```

Regras:

- É o dono de locks de processamento, filas, branch/rollback, cancel e transferência.
- Só acessa disco por `SessionMessageStore`.
- Só emite UI/CLI por `SessionEventPublisher`.
- Só renderiza artefatos por `SessionArtifactRenderer`, e nunca no caminho crítico de `sendMessage`.

### Runtime Native vs Hermes

A extração deve manter o contrato comum de backend ativo único, mas pode revelar duas implementações internas:

```ts
interface SessionRuntime {
  kind: 'native' | 'hermes-proxy'
  createAgent(session: ManagedSession): Promise<AgentInstance>
  send(agent: AgentInstance, input: RuntimeInput): AsyncIterable<AgentEvent>
  cancel(agent: AgentInstance, reason: AbortReason): Promise<void>
  destroy(agent: AgentInstance): void
}
```

Se a extração mostrar que Hermes precisa de HERMES_HOME, ACP session proxy, profile switching e MCP/session tools com regras diferentes demais, introduzir `NativeSessionRuntime` e `HermesSessionProxy`. Caso contrário, manter o runtime resolver atual e apenas isolar a interface.

## Aggregate `Session`

O aggregate fino deve preservar a superfície pública atual do `SessionManager` para reduzir blast radius:

```ts
class SessionManager implements ISessionManager {
  constructor(
    private readonly lifecycle: SessionLifecycleManager,
    private readonly store: SessionMessageStore,
    private readonly artifacts: SessionArtifactRenderer,
    private readonly events: SessionEventPublisher,
  ) {}
}
```

O aggregate deve:

- Manter compatibilidade com `handlers/rpc/sessions.ts` durante a migração.
- Delegar comportamento real aos submódulos.
- Conter apenas wiring, getters de compatibilidade e ciclo de vida de inicialização/cleanup.

## Estratégia de Migração

Recomendada: incremental, em PRs pequenos.

1. Extrair `SessionEventPublisher` primeiro, porque reduz duplicação de `eventSink`, delta batching e cleanup sem alterar storage.
2. Extrair `SessionArtifactRenderer` do handler RPC, porque deve ser isolado e não deve alterar lifecycle.
3. Extrair `SessionMessageStore`, começando por persist/flush/lazy-load e mantendo assinatura atual do aggregate.
4. Extrair `SessionLifecycleManager`, movendo create/send/cancel/branch/transfer depois que store e events já estiverem isolados.
5. Só então avaliar `NativeSessionRuntime` vs `HermesSessionProxy`.

Evitar big-bang. O refactor toca caminhos críticos de streaming, persistência, branch e Hermes; PR grande demais torna regressão difícil de localizar.

## Tests

- `SessionMessageStore`: testes isolados com diretório temporário para JSONL, lazy load, append, flush, truncate/rollback e sidecars de branch.
- `SessionEventPublisher`: testes com `EventSink` fake para ordenação, batching de deltas, flush antes de complete e cleanup de timers.
- `SessionArtifactRenderer`: testes com session.jsonl fixture contendo Mermaid válido, Mermaid inválido, limite de diagramas e idempotência de escrita.
- `SessionLifecycleManager`: testes com runtime fake para create/send/cancel/queue/branch/rollback/transfer sem spawn real.
- Aggregate `SessionManager`: testes de compatibilidade garantindo que handlers RPC continuam chamando a mesma API.
- Hermes: teste focado para profile/HERMES_HOME e ACP proxy quando `HermesSessionProxy` for introduzido.

## Trade-offs

- Refactor pesado em área crítica. O ganho é reduzir blast radius e deixar falhas de artefato/watcher fora do lifecycle.
- Introduzir interfaces demais cedo pode criar abstração artificial. Por isso, extrair primeiro os domínios que já têm comportamento identificável no código.
- A migração incremental mantém compatibilidade, mas temporariamente pode haver forwarding extra no aggregate.
- Big-bang seria mais rápido no curto prazo, mas aumenta risco de mudar sem querer ordenação de eventos, persistência JSONL ou comportamento de cancelamento.
