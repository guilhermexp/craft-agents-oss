## ADDED Requirements

### Requirement: Native runtime owns Claude and Pi providers
O sistema SHALL expor um runtime nativo que possui somente os provedores Claude via SDK Anthropic e Pi via subprocess `pi-agent-server`.

#### Scenario: Anthropic provider enters native runtime
- **WHEN** uma conexão de sessão resolve para provider type `anthropic`
- **THEN** o runtime nativo MUST selecionar o backend Claude SDK.

#### Scenario: Pi provider enters native runtime
- **WHEN** uma conexão de sessão resolve para provider type `pi` ou `pi_compat`
- **THEN** o runtime nativo MUST selecionar o backend Pi subprocess.

#### Scenario: Hermes provider is excluded
- **WHEN** uma conexão de sessão resolve para provider type `hermes`
- **THEN** o runtime nativo MUST NOT criar, importar ou configurar o backend Hermes.

### Requirement: Native runtime exposes a single spawn entry point
O sistema SHALL esconder factory, driver pool, discovery de capability, resolução de modelo e credential routing nativos atrás de uma única API pública.

#### Scenario: Consumer starts native session
- **WHEN** um consumer precisa iniciar uma sessão Claude ou Pi
- **THEN** ele MUST chamar o ponto de entrada público do runtime nativo em vez de escolher drivers diretamente.

#### Scenario: Runtime chooses driver internally
- **WHEN** o ponto de entrada nativo recebe a configuração resolvida da conexão
- **THEN** ele MUST escolher o driver Claude ou Pi sem exigir branching por provider nos consumers.

### Requirement: Native runtime routes credentials per native provider
O runtime nativo SHALL buscar e injetar credenciais apenas para o provedor nativo ativo.

#### Scenario: Claude uses Anthropic credentials
- **WHEN** o runtime nativo inicia Claude com API key ou OAuth Anthropic
- **THEN** ele MUST recuperar a credencial compartilhada e injetá-la no subprocess do SDK Anthropic.

#### Scenario: Pi uses Pi credentials
- **WHEN** o runtime nativo inicia Pi com API key, OAuth Copilot ou endpoint compatível
- **THEN** ele MUST recuperar a credencial compartilhada e injetá-la no protocolo de init do `pi-agent-server`.

#### Scenario: Native credential routing excludes Hermes
- **WHEN** o runtime nativo roteia credenciais
- **THEN** ele MUST NOT ler, escrever ou normalizar `HERMES_HOME`, `auth.json` Hermes ou config ACP Hermes.

### Requirement: Native model resolution is session-scoped
O runtime nativo SHALL resolver modelos Claude e Pi no escopo da sessão ativa.

#### Scenario: Claude model is selected
- **WHEN** uma sessão Claude define modelo gerenciado ou default da conexão
- **THEN** o runtime nativo MUST aplicar esse modelo somente ao backend Claude daquela sessão.

#### Scenario: Pi model is selected
- **WHEN** uma sessão Pi define modelo gerenciado, default da conexão ou modelos customizados compatíveis
- **THEN** o runtime nativo MUST aplicar essa seleção somente ao backend Pi daquela sessão.

#### Scenario: Cross-provider model is rejected
- **WHEN** o modelo gerenciado pertence a outro provedor nativo
- **THEN** o runtime nativo MUST usar o default da conexão ou fallback nativo apropriado.

### Requirement: Native runtime keeps Pi computer-use scoped to Pi
O runtime nativo SHALL expor ferramentas `computer-use` somente ao backend Pi.

#### Scenario: Pi supports computer-use
- **WHEN** o backend Pi inicia em ambiente desktop suportado e o pacote `pi-computer-use` está disponível
- **THEN** o runtime nativo MAY permitir nomes de ferramentas computer-use no subprocess Pi.

#### Scenario: Claude excludes Pi computer-use
- **WHEN** o backend Claude inicia pelo runtime nativo
- **THEN** ele MUST NOT receber pacote, allowlist ou configuração de ferramentas `computer-use` do Pi.
