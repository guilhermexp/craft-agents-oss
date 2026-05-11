## MODIFIED Requirements

### Requirement: Auth bridge scoped ao subprocesso

O sistema MUST injetar credenciais Craft no spawn do Python Hermes sem persistir secrets em seed resources, configuração global standalone ou superfície visual do dashboard.

#### Scenario: Spawn de sessão Hermes

- **WHEN** `HermesAgent` cria o provider ACP
- **THEN** `seedHermesAuthFromCraft` fornece env vars de credenciais para o subprocesso Hermes e escreve apenas o slot Codex esperado em `HERMES_HOME/auth.json`

#### Scenario: Dashboard Hermes

- **WHEN** o dashboard Hermes é iniciado pelo RPC handler ou pelo `hermes-dashboard-host`
- **THEN** o ambiente do dashboard recebe credenciais bridged do Craft sem exigir `.env` manual do Hermes embutido e sem expor secrets ao renderer

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
