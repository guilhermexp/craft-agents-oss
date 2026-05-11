## ADDED Requirements

### Requirement: Settings tabs cobrem superfícies de configuração
O sistema SHALL expor settings tabs para env, messengers, skills, logs, AI, input, labels, permissions, server, workspace e Hermes.

#### Scenario: Navegação de settings
- **WHEN** o usuário abre a área de settings no Electron
- **THEN** o sistema apresenta as superfícies de configuração registradas para env/app, messengers, skills, logs, AI, input, labels, permissions, server, workspace e Hermes.

### Requirement: Settings persistem alteração imediatamente
Cada settings tab SHALL persistir mudanças no momento da alteração ou confirmação local da própria tab, sem depender de um botão global de salvar.

#### Scenario: Alterar setting local
- **WHEN** o usuário muda uma configuração em uma tab de settings
- **THEN** o sistema persiste a alteração pelo handler ou storage correspondente sem exigir salvar global.

### Requirement: Preferences têm escopo correto
Preferences MUST ser escopadas por usuário ou workspace conforme a semântica do setting.

#### Scenario: Salvar preference de usuário
- **WHEN** o usuário altera nome, timezone, localização, idioma derivado ou notas pessoais
- **THEN** o sistema persiste a preference no escopo do usuário e não em um workspace específico.

#### Scenario: Salvar setting de workspace
- **WHEN** o usuário altera default de conexão, modelo, thinking level, working directory ou permissões de um workspace
- **THEN** o sistema persiste a alteração no escopo do workspace correspondente.

### Requirement: Tema light/dark/system aplica ao vivo
O sistema SHALL permitir tema light, dark e system e MUST aplicar a mudança ao vivo sem reload.

#### Scenario: Trocar modo de tema
- **WHEN** o usuário seleciona light, dark ou system nas configurações de aparência
- **THEN** o sistema atualiza o tema aplicado na UI em execução sem reiniciar ou recarregar o app.

### Requirement: Storage migrations rodam no startup
Storage migrations MUST rodar no startup, ser idempotentes e versionadas ou marcadas para execução única quando aplicável.

#### Scenario: Startup com config legada
- **WHEN** o app inicia com config em formato legado
- **THEN** o sistema aplica as migrations necessárias antes de expor a config para sessões, settings ou handlers RPC.

#### Scenario: Reexecutar migration
- **WHEN** uma migration já aplicada roda novamente
- **THEN** o sistema mantém o mesmo estado final sem duplicar entradas, sobrescrever customizações protegidas ou produzir efeitos adicionais.

### Requirement: Falha de migration bloqueia boot
O sistema MUST bloquear o boot quando uma storage migration obrigatória falha, sem permitir startup parcial com config inconsistente.

#### Scenario: Migration obrigatória falha
- **WHEN** uma migration de startup falha ao normalizar ou persistir config obrigatória
- **THEN** o sistema interrompe o boot dependente dessa config e reporta a falha em vez de iniciar parcialmente.

### Requirement: LLM connections validam credenciais antes de persistir
`llm-connections` MUST validar API key, OAuth ou credenciais equivalentes antes de persistir uma conexão nova ou credencial atualizada como utilizável.

#### Scenario: Credencial inválida
- **WHEN** o usuário tenta configurar uma LLM connection com API key, OAuth ou credencial inválida
- **THEN** o sistema rejeita a persistência como conexão utilizável e retorna o erro de validação.

#### Scenario: Credencial válida
- **WHEN** a validação de setup da LLM connection confirma credencial e conectividade
- **THEN** o sistema persiste a conexão e permite seu uso como default app-level ou workspace-level.

### Requirement: Hermes settings preservam provider models customizados
Hermes settings MUST preservar custom provider models, `base_url` e seleção de modelos definida pelo usuário quando atualizar configurações do dashboard ou do RPC.

#### Scenario: Dashboard não retorna modelos customizados
- **WHEN** o dashboard Hermes não retorna modelos para um provider customizado
- **THEN** o sistema mantém os modelos configurados pelo usuário ou resolve modelos a partir do endpoint customizado sem apagar a lista existente.

#### Scenario: Atualizar provider Hermes com base URL
- **WHEN** o usuário atualiza provider, modelo e `base_url` nas settings Hermes
- **THEN** o sistema persiste a alteração preservando o `base_url` e os modelos customizados compatíveis.

### Requirement: i18n parity é validada em CI
O sistema SHALL validar paridade de chaves i18n em CI por meio de `lint:i18n`.

#### Scenario: Chave i18n ausente
- **WHEN** uma settings tab adiciona ou altera texto traduzido sem chave equivalente nos locales exigidos
- **THEN** o lint de i18n falha no CI e bloqueia a validação da mudança.
