## ADDED Requirements

### Requirement: Gerenciamento de sessão separado por domínio
O sistema SHALL organizar o gerenciamento de sessão em subcapacidades com fronteiras explícitas para lifecycle, store de mensagens, renderização de artefatos e publicação de eventos, mantendo um aggregate fino como ponto de compatibilidade pública.

#### Scenario: Bug de artefato não quebra lifecycle
- **WHEN** a geração de um SVG Mermaid falha para uma sessão
- **THEN** a falha fica limitada ao renderer de artefatos e não altera criação, envio, cancelamento, branch, rollback ou persistência de mensagens da sessão.

#### Scenario: Bug de watcher não corrompe histórico
- **WHEN** o watcher de arquivos emite eventos duplicados, atrasados ou inválidos
- **THEN** o store de mensagens não regrava o histórico com estado obsoleto e o lifecycle da sessão continua independente.

### Requirement: Store de mensagens como dono da persistência
O sistema SHALL concentrar leitura, append, lazy load, flush e truncamento explícito de histórico em um `SessionMessageStore`, sem publicação direta de eventos e sem criação de backends.

#### Scenario: Persistir mensagem fora do lifecycle
- **WHEN** uma mensagem de usuário, assistant, tool, erro ou info persistível é aceita pelo lifecycle
- **THEN** o lifecycle delega a persistência ao `SessionMessageStore`, que grava o histórico append-only em ordem estável.

#### Scenario: Rollback usa truncamento explícito
- **WHEN** um rollback confirmado remove mensagens posteriores a um ponto histórico
- **THEN** o `SessionMessageStore` executa uma operação explícita de truncamento e preserva a invariância de replay do histórico restante.

### Requirement: Publisher de eventos isolado do store
O sistema SHALL publicar eventos de sessão e workspace por um `SessionEventPublisher` que controla canais RPC, batching de deltas e cleanup de timers sem escrever no storage.

#### Scenario: Finalizar streaming
- **WHEN** um backend finaliza uma resposta com deltas pendentes
- **THEN** o `SessionEventPublisher` flushes os deltas antes de publicar o evento final da sessão.

#### Scenario: Store persiste sem evento implícito
- **WHEN** o `SessionMessageStore` grava uma mensagem ou metadata
- **THEN** nenhum evento de renderer/CLI é emitido implicitamente pelo store; a publicação ocorre pelo lifecycle via `SessionEventPublisher`.

### Requirement: Renderer de artefatos assíncrono e não crítico
O sistema SHALL derivar artefatos de sessão, incluindo Mermaid e SVG, por um `SessionArtifactRenderer` assíncrono e rate-limited que não participe do caminho crítico de `sendMessage`.

#### Scenario: Listar arquivos com Mermaid
- **WHEN** a UI lista arquivos de uma sessão que contém blocos Mermaid no histórico
- **THEN** o `SessionArtifactRenderer` sincroniza os artefatos derivados de forma idempotente e retorna a árvore de arquivos sem expor arquivos internos como fonte de verdade da conversa.

#### Scenario: Mermaid inválido
- **WHEN** um bloco Mermaid não pode ser renderizado
- **THEN** o renderer registra/degrada a falha e a sessão continua com histórico e eventos intactos.

### Requirement: Runtime específico por backend atrás de interface comum
O sistema SHALL manter o contrato de backend ativo único por sessão atrás de uma interface de runtime comum e SHALL separar `NativeSessionRuntime` de `HermesSessionProxy` quando regras de ACP, `HERMES_HOME`, profile ou MCP session-scoped exigirem isolamento.

#### Scenario: Sessão Hermes usa proxy próprio
- **WHEN** uma sessão usa provider Hermes
- **THEN** o lifecycle resolve um runtime Hermes que preserva `HERMES_HOME`, profile ativo e endpoints MCP por sessão sem reutilizar pressupostos de runtimes nativos.

#### Scenario: Sessão nativa preserva contrato existente
- **WHEN** uma sessão usa backend nativo compatível
- **THEN** o lifecycle usa o runtime nativo mantendo branch, cancelamento, streaming e persistência com a mesma API observável atual.
