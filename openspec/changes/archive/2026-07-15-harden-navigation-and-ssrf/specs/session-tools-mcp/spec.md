# session-tools-mcp — delta F7 (R1, R4)

## ADDED Requirements

### Requirement: Scheme allowlist covers client-side navigation and redirects

A allowlist de esquemas do browser agêntico SHALL ser aplicada
(http/https + `about:blank`) a toda navegação de topo, incluindo navegação iniciada
pela própria página (`window.location`, meta refresh, formulários) e
redirects de servidor — não apenas ao call site `navigate` do agente e à
abertura de popups. Navegação client-side para esquema proibido SHALL ser
cancelada antes de iniciar; redirect para esquema proibido SHALL ser
interrompido reativamente (stop + about:blank). Deep links do Craft e
navegação http/https legítima SHALL continuar funcionando.

#### Scenario: página tenta window.location para file://

- **GIVEN** uma instância de browser agêntico com uma página web carregada
- **WHEN** a página dispara navegação de topo para `file:///etc/passwd`
- **THEN** a navegação é cancelada (`preventDefault`) e logada
- **AND** o conteúdo do arquivo local nunca carrega no `webContents`

#### Scenario: navegação https legítima não é afetada

- **GIVEN** uma instância de browser agêntico
- **WHEN** a página navega para `https://ok.com`
- **THEN** a navegação prossegue sem bloqueio

#### Scenario: deep link do Craft continua tratado

- **GIVEN** uma instância de browser agêntico
- **WHEN** a página navega para `craftagents://…`
- **THEN** o deep link é encaminhado ao handler do Craft (não bloqueado pela allowlist)

#### Scenario: redirect de servidor para esquema proibido

- **GIVEN** uma navegação main-frame em andamento
- **WHEN** um redirect leva a uma URL de esquema proibido
- **THEN** o carregamento é interrompido e o webContents vai para `about:blank`

### Requirement: Element refs are invalidated on subframe navigation

Os refs `@eN` de snapshot SHALL ser invalidados quando qualquer frame do
`webContents` navega (`did-frame-navigate`), não apenas em navegação do main
frame. Um ref capturado antes da navegação de um iframe SHALL resolver como
stale, nunca para um backendNodeId reciclado.

#### Scenario: iframe navega e refs anteriores viram stale

- **GIVEN** um snapshot que inclui elementos dentro de um iframe
- **WHEN** apenas o iframe navega/recarrega (`did-frame-navigate`)
- **THEN** todos os mapas de refs são limpos
- **AND** usar um ref antigo produz erro de ref stale pedindo novo snapshot
