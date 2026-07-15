## MODIFIED Requirements

### Requirement: Bot recebe contexto da reunião

O sistema SHALL entregar contexto da reunião ao entrar, nos dois lados que existem hoje: o **bot** recebe no payload de start o link normalizado do Google Meet, a identidade de convidado (guest name), o modo de captura e o caminho do auth state do bot dedicado; o **registro Craft** da reunião recebe link e título (quando disponível) no record e no summary inicial. Participantes e agenda não são coletados pelo sistema hoje: campos ausentes MUST ser tratados como desconhecidos sem bloquear o convite, e o sistema MUST NOT inventá-los.

#### Scenario: Bot recebe payload de start ao entrar

- **WHEN** o bot Hermes é iniciado para uma reunião (`captureMode: hermes` com transcrição habilitada)
- **THEN** o comando `start` do plugin `google_meet` recebe a URL normalizada `meet.google.com`, o guest name do bot, o modo de captura e o auth state do bot dedicado
- **AND** o start falha com erro claro se o auth state do bot não existir

#### Scenario: Contexto acompanha o convite

- **WHEN** Hermes é convidado para uma reunião com metadados de convite disponíveis
- **THEN** o record Craft da reunião e seu summary inicial recebem link e título da reunião

#### Scenario: Contexto parcial continua válido

- **WHEN** apenas o link do Google Meet está disponível
- **THEN** o sistema inicia a reunião com o link e trata participantes ou agenda como desconhecidos sem bloquear o convite
