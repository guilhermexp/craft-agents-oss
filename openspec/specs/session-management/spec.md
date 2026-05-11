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

