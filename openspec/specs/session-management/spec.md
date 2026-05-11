# session-management Specification

## Purpose
Gerenciar o ciclo de vida completo das sessões de agente (criar, persistir, streamar, branch/rollback, labels, status, anexos, cancel, transfer) através do SessionManager em `server-core`, com histórico append-only ordenado, propagação correta de cancel até o backend e garantia de apenas um backend ativo por sessão.
## Requirements
### Requirement: Sessão persistida com identidade e metadados
O sistema SHALL persistir cada sessão com id estável, `workspaceId` ou `workspaceRootPath`, status, labels e metadata suficiente para reabrir a conversa no workspace correto.

#### Scenario: Reabrir sessão existente
- **WHEN** o usuário reabre uma sessão persistida
- **THEN** o sistema restaura id, workspace, status, labels, timestamps, configuração de modelo/conexão e demais metadados persistidos.

#### Scenario: Listar sessões sem carregar histórico completo
- **WHEN** o sistema lista sessões de um workspace
- **THEN** o sistema usa metadata persistida para retornar dados de lista sem depender do replay completo de mensagens.

### Requirement: Histórico de mensagens append-only
O sistema SHALL registrar mensagens no histórico em ordem estável, preservando mensagens de usuário, assistant, tools, erros, status persistidos e anexos associados.

#### Scenario: Adicionar nova mensagem
- **WHEN** uma nova mensagem é aceita em uma sessão
- **THEN** o sistema adiciona a mensagem ao fim do histórico e preserva a ordem por timestamp monotônico e/ou sequência persistida.

#### Scenario: Recarregar histórico
- **WHEN** uma sessão é carregada do storage
- **THEN** o sistema reconstrói as mensagens na mesma ordem em que foram persistidas.

### Requirement: Streaming ordenado e sem duplicação
O sistema SHALL entregar eventos de streaming ao renderer/CLI em ordem por sessão e sem duplicar deltas finais, tool calls, tool results ou reasoning/status equivalentes.

#### Scenario: Stream de resposta com tools
- **WHEN** o backend emite text delta, tool start, tool result e complete para uma sessão
- **THEN** o sistema envia esses eventos pelo canal RPC da sessão na ordem processada e deduplica tools pelo identificador de tool use.

#### Scenario: Finalizar texto em streaming
- **WHEN** o backend emite conclusão de texto
- **THEN** o sistema flushes deltas pendentes antes de emitir o evento final e persistir a mensagem final.

### Requirement: Branch a partir de ponto histórico
O sistema SHALL criar uma nova sessão de branch a partir da mensagem N de uma sessão origem, preservando o histórico até N e registrando metadados de origem necessários para branch nativo do backend quando disponíveis.

#### Scenario: Criar branch válido
- **WHEN** o usuário solicita branch de uma sessão origem com `branchFromSessionId` e `branchFromMessageId` válidos
- **THEN** o sistema cria uma nova sessão com as mensagens até a mensagem informada e metadata de branch apontando para a origem.

#### Scenario: Bloquear branch inválido
- **WHEN** a sessão origem, a mensagem origem ou o backend compatível não podem ser validados
- **THEN** o sistema rejeita a criação do branch e não deixa sessão persistida com metadata de branch inconsistente.

### Requirement: Rollback confirmado na sessão atual
O sistema SHALL permitir rollback de uma sessão até a mensagem N somente após confirmação explícita da UI, descartando mensagens posteriores na mesma sessão.

#### Scenario: Confirmar rollback
- **WHEN** o usuário confirma rollback até uma mensagem existente
- **THEN** o sistema remove da sessão atual as mensagens posteriores à mensagem informada e persiste o histórico truncado.

#### Scenario: Recusar rollback sem confirmação
- **WHEN** uma solicitação de rollback chega sem confirmação explícita
- **THEN** o sistema não altera o histórico persistido da sessão.

### Requirement: Labels e status atualizáveis durante streaming
O sistema SHALL permitir atualização de labels e status da sessão sem interromper streaming ou processamento ativo do backend.

#### Scenario: Atualizar labels durante resposta
- **WHEN** labels são alteradas enquanto a sessão está processando
- **THEN** o sistema persiste a nova lista de labels e emite evento de labels sem cancelar o backend ativo.

#### Scenario: Atualizar status durante resposta
- **WHEN** status é alterado enquanto a sessão está processando
- **THEN** o sistema persiste o novo status e emite evento de status sem cancelar o backend ativo.

### Requirement: Anexos restauráveis por turn
O sistema SHALL vincular anexos de usuário a uma mensagem ou turn específico e restaurar metadados e arquivos associados ao reabrir a sessão.

#### Scenario: Persistir anexo de mensagem
- **WHEN** o usuário envia uma mensagem com anexos de áudio, imagem ou documento
- **THEN** o sistema copia os arquivos para o diretório da sessão e persiste metadados de anexo na mensagem correspondente.

#### Scenario: Reabrir sessão com anexos
- **WHEN** a sessão é reaberta
- **THEN** o sistema restaura mensagens com seus anexos e caminhos/thumbnail/markdown associados quando disponíveis.

### Requirement: Backend ativo único por sessão
O `SessionManager` SHALL garantir que no máximo um backend de agente esteja ativo para uma sessão em um dado momento.

#### Scenario: Enviar mensagem para sessão sem backend
- **WHEN** uma mensagem é enviada para uma sessão sem backend ativo
- **THEN** o `SessionManager` cria ou restaura o backend apropriado para aquela sessão antes de processar a mensagem.

#### Scenario: Enviar mensagem durante processamento
- **WHEN** uma nova mensagem chega enquanto a sessão já está processando
- **THEN** o `SessionManager` usa redirect/queue/cancel conforme suporte do backend sem criar um segundo backend concorrente para a mesma sessão.

### Requirement: Cancelamento propaga ao backend e libera recursos
O sistema SHALL propagar cancelamento de sessão até o backend ativo, interromper processamento, limpar filas aplicáveis e liberar recursos associados ao runtime da sessão.

#### Scenario: Cancelar sessão em processamento
- **WHEN** o usuário cancela uma sessão que está processando
- **THEN** o sistema sinaliza abort ao backend, marca interrupção para a UI e finaliza estado de processamento da sessão.

#### Scenario: Cancelar sessão sem processamento
- **WHEN** o usuário cancela uma sessão que não está processando
- **THEN** o sistema não altera o histórico nem emite efeitos destrutivos.

### Requirement: Transferência preserva histórico e anexos quando implementada
O sistema SHALL preservar histórico e anexos em transferências por bundle completo entre workspaces. Quando transferência remota resumida for usada, o sistema SHALL preservar metadados compatíveis e indicar que o handoff depende de resumo, não de histórico/anexos completos.

#### Scenario: Importar bundle completo
- **WHEN** uma sessão é importada por bundle completo para outro workspace
- **THEN** o sistema grava o histórico, restaura arquivos do diretório da sessão e registra a sessão no workspace destino.

#### Scenario: Importar handoff remoto resumido
- **WHEN** uma sessão é importada por payload remoto resumido
- **THEN** o sistema cria uma nova sessão no workspace destino com nome, status, labels, permission mode e resumo transferido para contexto inicial.

### Requirement: State por client de sessão pertence ao SessionManager
O `SessionManager` SHALL possuir o lifecycle de state por client relacionado a sessões, incluindo file watchers, debounce de eventos de arquivo, cleanup em desconexão e fallback de erro de streaming.

#### Scenario: Client passa a observar arquivos de sessão
- **WHEN** um client solicita observação dos arquivos de uma sessão
- **THEN** o RPC handler encaminha a solicitação ao `SessionManager`
- **AND** o `SessionManager` cria ou atualiza o watcher associado ao client e à sessão.

#### Scenario: Arquivo visível muda na sessão
- **WHEN** um arquivo visível da pasta da sessão muda
- **THEN** o `SessionManager` aplica debounce e emite `sessions.FILES_CHANGED` para o client correto.

#### Scenario: Client desconecta ou para de observar
- **WHEN** o client desconecta ou solicita parar observação
- **THEN** o `SessionManager` fecha watchers, limpa timers e remove o state por client correspondente.

### Requirement: Transferências de sessão têm manager explícito
Transferências grandes vinculadas a sessões SHALL ser controladas por um manager ou serviço explícito, não por estado global no handler RPC.

#### Scenario: Transferência chunked inicia
- **WHEN** um client inicia uma transferência chunked para importar sessão
- **THEN** o handler RPC delega criação de diretório temporário, owner client, TTL e chunks esperados ao manager de transferência.

#### Scenario: Transferência termina ou expira
- **WHEN** a transferência é commitada, abortada ou expira por TTL
- **THEN** o manager limpa timers, arquivos temporários e registros ativos sem depender de cleanup manual no handler RPC.

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

