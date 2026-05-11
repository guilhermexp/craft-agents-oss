## ADDED Requirements

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
