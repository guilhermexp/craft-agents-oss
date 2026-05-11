# hermes-embed Specification

## Purpose
Embutir o runtime Python/ACP Hermes no app Electron de forma isolada (HERMES_HOME app-scoped, sem `~/.hermes`), vendorizado a partir de upstream pinado mais patches overlay, com bootstrap idempotente de seed skills e auth bridge controlado pelo Craft. Garante que o app empacotado funcione fechado, sem fallback para `hermes` do PATH, mantendo Hermes desacoplado dos backends Claude e Pi.
## Requirements
### Requirement: Runtime Hermes vendorizado

O sistema MUST empacotar o runtime Hermes Python/ACP em `apps/electron/resources/vendor/hermes` no checkout de desenvolvimento e em `app/vendor/hermes` no pacote Electron.

#### Scenario: Bundle gera runtime

- **WHEN** o bundle Hermes é executado para release ou desenvolvimento
- **THEN** o runtime gerado contém Python, `hermes-venv`, source mirror `hermes-agent` e binários auxiliares sob `apps/electron/resources/vendor/hermes`

#### Scenario: Package inclui runtime sem duplicação

- **WHEN** o pacote Electron é produzido
- **THEN** `electron-builder` inclui o runtime via `extraResources` em `app/vendor/hermes` e `copy-assets.ts` exclui `resources/vendor/hermes` de `dist/resources`

### Requirement: Home Hermes app-scoped

O sistema MUST usar `HERMES_HOME` app-scoped sob `Electron userData/hermes` para o Hermes embutido e NÃO DEVE usar `~/.hermes` nesse modo.

#### Scenario: Main publica home app-scoped

- **WHEN** o Electron main resolve o runtime Hermes embutido
- **THEN** `CRAFT_HERMES_HOME` aponta para `app.getPath('userData')/hermes`

#### Scenario: Backend normaliza home embutido

- **WHEN** `normalizeHermesRuntimeConfig` recebe `CRAFT_HERMES_HOME`
- **THEN** o runtime normalizado usa esse caminho para `hermesHome`, `configPath` e `envPath`

### Requirement: Seed skills copiadas com preservação

O sistema MUST copiar skills de `resources/hermes-seed` para `HERMES_HOME` no bootstrap apenas quando o destino estiver ausente, preservando edições do usuário.

#### Scenario: Skill seed ausente

- **WHEN** `ensureHermesSeedSkills` encontra uma skill listada no manifesto sem diretório correspondente no `HERMES_HOME`
- **THEN** a skill é copiada para `HERMES_HOME/skills/craft/...`

#### Scenario: Skill editada pelo usuário

- **WHEN** o destino da skill já existe no `HERMES_HOME`
- **THEN** o bootstrap ignora a cópia e mantém o conteúdo existente

### Requirement: Manifesto de seed bloqueia path traversal

O sistema MUST rejeitar entradas de manifesto com paths absolutos, segmentos `..` ou backslashes.

#### Scenario: Manifesto inseguro

- **WHEN** uma entrada de seed usa source ou target inseguro
- **THEN** `ensureHermesSeedSkills` registra erro, não copia a entrada e não cria o destino fora do escopo permitido

### Requirement: Build empacotado falha fechado sem runtime

O sistema MUST falhar fechado em app empacotado quando o Python vendorizado do Hermes estiver ausente, sem fallback para `hermes` do `PATH`.

#### Scenario: Python vendorizado ausente no pacote

- **WHEN** o app está empacotado e o Python esperado não existe
- **THEN** o main define `CRAFT_HERMES_REQUIRE_BUNDLED=1` e `CRAFT_HERMES_MISSING_COMMAND`

#### Scenario: Runtime obrigatório sem comando vendorizado

- **WHEN** `CRAFT_HERMES_REQUIRE_BUNDLED=1` está ativo
- **THEN** `normalizeHermesRuntimeConfig` usa o comando ausente configurado e não usa o binário `hermes` do sistema

### Requirement: Auth bridge scoped ao subprocesso

O sistema MUST injetar credenciais Craft no spawn do Python Hermes sem persistir secrets em seed resources, configuração global standalone ou superfície visual do dashboard.

#### Scenario: Spawn de sessão Hermes

- **WHEN** `HermesAgent` cria o provider ACP
- **THEN** `seedHermesAuthFromCraft` fornece env vars de credenciais para o subprocesso Hermes e escreve apenas o slot Codex esperado em `HERMES_HOME/auth.json`

#### Scenario: Dashboard Hermes

- **WHEN** o dashboard Hermes é iniciado pelo RPC handler ou pelo `hermes-dashboard-host`
- **THEN** o ambiente do dashboard recebe credenciais bridged do Craft sem exigir `.env` manual do Hermes embutido e sem expor secrets ao renderer

### Requirement: ACP session.mcpServers preserva nomes Craft

O sistema MUST expor `craft-session` e `craft-sources` a Hermes por ACP `session.mcpServers`, mantendo nomes canônicos Craft nas ferramentas nativas.

#### Scenario: Sessão com source pool e session tools

- **WHEN** `HermesAgent` cria a sessão ACP com `poolServerUrl` e `sessionToolsServerUrl`
- **THEN** `session.mcpServers` contém servidores HTTP chamados `craft-sources` e `craft-session`

#### Scenario: Nome de ferramenta Craft

- **WHEN** Hermes converte ferramentas desses servidores MCP
- **THEN** ferramentas de sessão usam nomes como `mcp__session__browser_tool` e source tools usam nomes como `mcp__github__search_issues`

### Requirement: RPC Hermes preserva providers customizados e valida input

O RPC handler Hermes MUST preservar provider models customizados, `base_url` de provider, validar inputs/caminhos antes de operar no `HERMES_HOME` e tratar o host visual do dashboard como responsabilidade separada da capability `hermes-dashboard-host`.

#### Scenario: Provider customizado sem modelos do dashboard

- **WHEN** o dashboard não retorna modelos para um provider customizado
- **THEN** o handler consulta modelos configurados/localmente ou endpoint `/models` do `base_url` quando disponível

#### Scenario: Atualização de modelo com base URL

- **WHEN** `PATCH_API_CONFIG` recebe provider, model e `base_url`
- **THEN** o handler atualiza o modelo principal e preserva `base_url` no YAML bruto do Hermes

#### Scenario: Acesso a logs e arquivos

- **WHEN** um RPC de leitura/listagem recebe um caminho relativo
- **THEN** o handler resolve o caminho dentro do `HERMES_HOME` e rejeita escapes por resolução real de path

#### Scenario: Host visual separado

- **WHEN** uma mudança altera mount/unmount, navegação, reload ou eventos visuais do dashboard Hermes
- **THEN** a mudança atualiza a capability `hermes-dashboard-host` além de manter `hermes-embed` limitado a runtime, seed, bundling, ACP, auth bridge e APIs locais

### Requirement: Patches overlay validados antes do bundle

O sistema MUST manter patches Craft em `apps/electron/scripts/hermes-patches/*.patch` e validar cada patch com `git apply --check` antes de aplicar ou empacotar.

#### Scenario: Patch incompatível com pin

- **WHEN** um patch overlay não aplica ao checkout pinado do Hermes
- **THEN** o bundle aborta antes de gerar o runtime vendorizado

#### Scenario: Patch compatível com pin

- **WHEN** todos os patches passam em `git apply --check`
- **THEN** o bundle aplica os patches em ordem e continua a instalação do runtime Python/ACP

### Requirement: Runtime Hermes state pertence a serviço dedicado
O sistema SHALL manter estado de lifecycle do Hermes embedded em um manager ou serviço dedicado, não no handler RPC.

#### Scenario: Dashboard Hermes é iniciado
- **WHEN** um client solicita iniciar o dashboard Hermes
- **THEN** o handler RPC delega ao serviço Hermes
- **AND** o serviço controla subprocesso, porta, URL, promise de inicialização e shutdown.

#### Scenario: Auth do Hermes muda
- **WHEN** o `auth.json` no `HERMES_HOME` app-scoped muda
- **THEN** o serviço Hermes aplica debounce, sincroniza tokens autorizados para o store do Craft e evita watchers duplicados.

#### Scenario: Update marker muda
- **WHEN** o dashboard Hermes grava o marker de update
- **THEN** o serviço Hermes detecta a alteração, interpreta o resultado e emite notificação ou evento necessário sem depender de timer local no handler RPC.

### Requirement: Hermes is an external embedded integration
O sistema SHALL tratar Hermes como sistema externo embedded via ACP/MCP, não como peer nativo da factory Claude/Pi.

#### Scenario: Native runtime is initialized
- **WHEN** o runtime nativo Claude/Pi é inicializado
- **THEN** ele MUST NOT registrar driver Hermes, normalizar config Hermes, resolver dashboard Hermes ou tocar `HERMES_HOME`.

#### Scenario: Hermes session starts
- **WHEN** uma sessão Hermes é iniciada
- **THEN** ela MUST usar o caminho `hermes-embed` com `HermesAgent`, `acp-config.ts`, auth bridge Hermes e `session.mcpServers` ACP.

#### Scenario: Hermes dashboard starts
- **WHEN** o dashboard Hermes é iniciado pelo Craft
- **THEN** ele MUST usar configuração, ambiente e paths do contrato Hermes embedded, sem depender da factory nativa Claude/Pi.

