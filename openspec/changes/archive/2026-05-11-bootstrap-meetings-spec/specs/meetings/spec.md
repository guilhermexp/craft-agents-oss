## ADDED Requirements

### Requirement: Hermes pode ser convidado pelo BrowserView
O sistema SHALL permitir que o usuário convide Hermes para um Google Meet detectado na toolbar do BrowserView interno.

#### Scenario: Convidar a partir da toolbar
- **WHEN** a toolbar do BrowserView detecta uma URL válida de Google Meet e o usuário aciona "Convidar Hermes"
- **THEN** o sistema inicia o fluxo de reunião usando a URL detectada, o perfil do navegador e a instância BrowserView existente.

#### Scenario: Rejeitar URL que não é Google Meet
- **WHEN** o convite recebe uma URL que não pertence a `meet.google.com` ou não contém código de reunião válido
- **THEN** o sistema MUST rejeitar o início da reunião com erro claro.

### Requirement: Runtime do Meet bot é vendorizado
O sistema MUST executar o Google Meet bot a partir do runtime Hermes vendorizado em `apps/electron/resources/vendor/hermes` no checkout de desenvolvimento ou do caminho equivalente empacotado.

#### Scenario: Bot inicia pelo runtime vendorizado
- **WHEN** uma reunião é iniciada com transcrição habilitada
- **THEN** o sistema executa o plugin `google_meet` usando o Python, venv e source mirror do Hermes vendorizado.

#### Scenario: Dependências do Meet bot estão no bundle
- **WHEN** o bundle Hermes é produzido
- **THEN** o runtime vendorizado contém as dependências necessárias do Google Meet bot, incluindo Playwright/Chromium quando aplicável.

### Requirement: Autenticação Google é protegida
O sistema MUST usar autenticação Google baseada em OAuth para APIs de Calendar/Meet/Drive e MUST NOT registrar tokens, cookies ou bearer secrets em logs.

#### Scenario: OAuth Google concede acesso a APIs
- **WHEN** o usuário autentica uma source Google vinculada ao workspace
- **THEN** o sistema usa OAuth com escopos explícitos para acessar Calendar, Meet ou Drive conforme a source configurada.

#### Scenario: Logs não expõem secrets
- **WHEN** handlers, bot ou runtime registram eventos de autenticação Google
- **THEN** os logs MUST NOT conter access tokens, refresh tokens, cookies, authorization codes ou bearer tokens.

### Requirement: Workspace files tab lista arquivos vinculados
O sistema SHALL listar arquivos do Drive/Workspace vinculados ao workspace do usuário para que Hermes possa consumi-los como contexto autorizado.

#### Scenario: Listar arquivos autenticados do workspace
- **WHEN** o usuário abre a workspace files tab com uma source Google Drive autenticada
- **THEN** o sistema lista os arquivos disponíveis para aquele workspace sem expor credenciais ao renderer.

#### Scenario: Workspace sem autenticação
- **WHEN** a source Google Drive exige autenticação e o workspace ainda não possui OAuth válido
- **THEN** o sistema solicita autenticação em vez de retornar arquivos protegidos.

### Requirement: Bot recebe contexto da reunião
O sistema SHALL entregar ao bot e à sessão Craft o contexto da reunião ao entrar, incluindo link, participantes conhecidos e agenda quando disponíveis.

#### Scenario: Contexto acompanha o convite
- **WHEN** Hermes é convidado para uma reunião com metadados de convite disponíveis
- **THEN** a sessão Craft da reunião recebe link, título, participantes conhecidos e agenda como contexto inicial.

#### Scenario: Contexto parcial continua válido
- **WHEN** apenas o link do Google Meet está disponível
- **THEN** o sistema inicia a reunião com o link e marca participantes ou agenda como desconhecidos sem bloquear o convite.

### Requirement: Encerramento libera recursos do bot
O sistema MUST liberar recursos do Google Meet bot quando a reunião é encerrada.

#### Scenario: Parar reunião ativa
- **WHEN** o usuário ou o sistema encerra uma reunião ativa
- **THEN** o sistema chama o comando de parada do Meet bot, encerra o subprocesso ativo e atualiza o status da reunião.

#### Scenario: Processo já terminou
- **WHEN** a reunião é encerrada mas o subprocesso do bot já não está ativo
- **THEN** o sistema limpa o ponteiro ativo e retorna estado final sem deixar a reunião como `running`.

### Requirement: Build empacotado falha fechado sem runtime
O sistema MUST falhar fechado quando o app empacotado não contém o runtime Hermes necessário para convidar Hermes ao Meet.

#### Scenario: Runtime ausente em build empacotado
- **WHEN** o usuário tenta convidar Hermes para um Meet em um app empacotado sem runtime vendorizado
- **THEN** o comando de convite falha com erro claro e MUST NOT executar um `hermes` global do `PATH`.

#### Scenario: Runtime presente
- **WHEN** o runtime Hermes vendorizado está presente e o bot está autenticado
- **THEN** o comando de convite pode iniciar o subprocesso do Meet bot.
