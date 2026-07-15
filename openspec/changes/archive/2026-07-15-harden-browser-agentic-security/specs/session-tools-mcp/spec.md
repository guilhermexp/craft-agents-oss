## ADDED Requirements

### Requirement: Agentic browser navigation is restricted to safe top-level schemes

O browser controlado por agente SHALL restringir a navegação de topo e a
abertura de popups a esquemas `http:` e `https:` (mais `about:blank`),
rejeitando `file:`, `chrome:`, e quaisquer outros esquemas. A rejeição SHALL
produzir um erro claro citando o esquema bloqueado. A validação SHALL ser a
mesma para `navigate` (ferramenta de agente) e para o handler de abertura de
janelas (popups).

#### Scenario: navigate para file:// é rejeitado

- **GIVEN** um agente controla uma instância de browser
- **WHEN** o agente chama `browser_tool navigate` com `file:///etc/passwd`
- **THEN** a navegação é rejeitada com erro citando o esquema `file:`
- **AND** a página local não é carregada no `webContents`

#### Scenario: navigate para chrome:// é rejeitado

- **GIVEN** um agente controla uma instância de browser
- **WHEN** o agente chama `browser_tool navigate` com `chrome://settings`
- **THEN** a navegação é rejeitada com erro citando o esquema `chrome:`

#### Scenario: navigate para https é permitido

- **GIVEN** um agente controla uma instância de browser
- **WHEN** o agente chama `browser_tool navigate` com `https://example.com`
- **THEN** a navegação prossegue normalmente

#### Scenario: popup com esquema não-http é negado

- **GIVEN** uma página tenta abrir uma janela via `window.open`
- **WHEN** a URL alvo usa um esquema diferente de http/https/about:blank
- **THEN** a abertura da janela é negada

### Requirement: Remote evaluate gate applies to the local agent path

O gate `allowRemoteEvaluate` SHALL ser aplicado também no path local
(agente → SessionManager → browser pane), não apenas no path remoto
(dispatcher). Quando `allowRemoteEvaluate` for `false`, `browser_tool evaluate`
SHALL rejeitar com erro claro antes de executar qualquer JavaScript na página.

#### Scenario: evaluate rejeitado quando config desabilita

- **GIVEN** `allowRemoteEvaluate` está `false` na configuração do cliente
- **WHEN** um agente chama `browser_tool evaluate` pelo path local
- **THEN** a chamada é rejeitada com erro indicando que `browser_evaluate` está
  desabilitado por config
- **AND** nenhum JavaScript é executado na página

### Requirement: Browser session permissions are per-partition and deny sensitive access by default

O handler de permissões do browser agêntico SHALL ser registrado para **toda**
partition/profile, não apenas a primeira. Permissões sensíveis
(`clipboard-read`, `display-capture`) SHALL ser negadas por default sem prompt.

#### Scenario: handler registrado em partitions secundárias

- **GIVEN** o browser cria instâncias em dois profiles/partitions distintos
- **WHEN** cada partition é inicializada
- **THEN** o handler de permissões é registrado em ambas as partitions
- **AND** nenhuma partition cai no default permissivo do Electron

#### Scenario: clipboard-read e display-capture negados por default

- **GIVEN** uma origem qualquer solicita `clipboard-read` ou `display-capture`
- **WHEN** o handler de permissões avalia o pedido
- **THEN** o pedido é negado
- **AND** permissões como `geolocation` permanecem no allow-set default
