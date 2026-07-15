# session-tools-mcp Specification

## Purpose
Expor ferramentas MCP session-scoped que agentes recebem em runtime (browser, sources, config, memory, sandbox, render template, transform data, mermaid validate, etc.), com cada tool recebendo (workspaceId, sessionId) injetado pelo servidor. Garante isolamento entre sessões, sandbox seguro de scripts (FS/path/network) e nomenclatura `mcp__session__*` preservada para consumidores Hermes via ACP.
## Requirements
### Requirement: Tools are session-scoped
The system SHALL execute session MCP tools with backend-injected session context containing the active `workspaceId` and `sessionId`, and tools MUST NOT operate on an arbitrary session outside that context.

#### Scenario: Tool executes with active session context
- **WHEN** an agent calls a session MCP tool
- **THEN** the tool receives the backend-injected workspace and session context for the active session

#### Scenario: Optional session IDs remain controlled
- **WHEN** a tool accepts an optional `sessionId` for metadata, labels, status, messaging, or coordination
- **THEN** the backend-scoped callback controls resolution and authorization instead of trusting unrestricted arbitrary session access

### Requirement: Session MCP server is the entrypoint
The system SHALL expose Craft session tools to MCP consumers through `session-mcp-server` or the Craft session tools MCP bridge, and agents MUST consume them through ACP/MCP transports instead of static global tool wiring.

#### Scenario: Stdio MCP consumer starts session tools
- **WHEN** a subprocess MCP consumer starts `packages/session-mcp-server`
- **THEN** the process exposes the session tools over MCP stdio with the provided session arguments

#### Scenario: Hermes receives session tools through ACP
- **WHEN** Hermes starts or resumes a Craft session
- **THEN** `HermesAgent` passes the per-session `craft-session` MCP endpoint through ACP `session.mcpServers`

### Requirement: Hermes naming is preserved
The system SHALL preserve Craft session tool names under the Hermes consumer prefix `mcp__session__<tool>`.

#### Scenario: Hermes lists Craft session tools
- **WHEN** Hermes receives the `craft-session` MCP server
- **THEN** tools such as `browser_tool`, `spawn_session`, and `call_llm` are available to Hermes as `mcp__session__browser_tool`, `mcp__session__spawn_session`, and `mcp__session__call_llm`

### Requirement: Script sandbox isolates filesystem path and network
The `script_sandbox` tool SHALL isolate filesystem writes to the session workspace, MUST reject path escape attempts including `..` and symlink escapes, and MUST block undeclared outbound network access.

#### Scenario: Input path escapes session directory
- **WHEN** `script_sandbox` receives an input path that resolves outside the active session directory
- **THEN** the tool returns an error tool result and does not execute the script

#### Scenario: Isolation backend is unavailable
- **WHEN** the runtime cannot enforce filesystem or network isolation
- **THEN** `script_sandbox` fails closed with an error tool result

### Requirement: Source test validates before persistence
The `source_test` tool SHALL validate a source connection before accepting persistent source activation or updated connection metadata.

#### Scenario: Source connection fails validation
- **WHEN** `source_test` cannot validate schema, connection, or authentication for a source
- **THEN** it returns an error tool result and does not accept the source as successfully activated

#### Scenario: Source connection passes validation
- **WHEN** `source_test` validates the source successfully and auto-enable is enabled
- **THEN** it may persist test metadata and enable or activate the source for the active session

### Requirement: Memory tools are session-scoped
The `memory_recall` and `memory_store` tools SHALL run only through the active session context and MUST NOT leak memory operations between unrelated sessions.

#### Scenario: Memory feature is disabled
- **WHEN** an agent calls `memory_recall` or `memory_store` without memory callbacks configured for the session
- **THEN** the tool returns an error tool result instead of accessing memory globally

#### Scenario: Memory feature is enabled
- **WHEN** an agent stores or recalls memory
- **THEN** the operation uses the memory callbacks injected for the active session context

### Requirement: Render and transform side effects are constrained
The `render_template` and `transform_data` tools SHALL avoid external side effects and MUST only write declared output artifacts inside the active session data area.

#### Scenario: Render template runs
- **WHEN** `render_template` receives a valid source template and data
- **THEN** it renders the template and writes only the returned HTML artifact in the active session data directory

#### Scenario: Transform output escapes data directory
- **WHEN** `transform_data` receives an output path that resolves outside the session data directory
- **THEN** it returns an error tool result and does not execute the transform

### Requirement: Mermaid is validated before success
The `mermaid_validate` tool SHALL parse Mermaid syntax before returning a successful validation result.

#### Scenario: Mermaid syntax is invalid
- **WHEN** `mermaid_validate` receives invalid Mermaid code
- **THEN** it returns an error tool result with validation details

#### Scenario: Mermaid syntax is valid
- **WHEN** `mermaid_validate` receives valid Mermaid code
- **THEN** it returns a successful tool result indicating the diagram syntax is valid

### Requirement: Tool failures are returned as tool results
Session MCP tools SHALL return failures as structured tool results and MUST NOT expose bare exceptions as the normal error contract.

#### Scenario: Handler catches expected failure
- **WHEN** a handler detects invalid input, unavailable backend capability, or failed validation
- **THEN** it returns a tool result marked as an error with a clear message

#### Scenario: Handler throws unexpectedly
- **WHEN** a session MCP handler throws unexpectedly
- **THEN** the MCP server catches the error and returns an error tool result to the agent

### Requirement: Session tools expose a versioned frontier API
The system SHALL treat `session-tools-mcp` as a versioned frontier API shared by native TypeScript consumers and Hermes ACP/MCP consumers.

#### Scenario: Existing tools are exposed as v1
- **WHEN** the system exposes an existing session tool to native agents or Hermes
- **THEN** the tool is associated with API version `v1` and preserves its existing public name, including the Hermes `mcp__session__<tool>` consumer name

#### Scenario: Breaking contract change is introduced
- **WHEN** a tool changes its public name, required input, output shape, or documented error contract incompatibly
- **THEN** the change is introduced under a new major API version instead of mutating the active `v1` contract in place

### Requirement: Tool schemas are explicit and canonical
Every session tool exposed through `session-tools-mcp` SHALL declare explicit canonical input and output schemas before it is available to native or ACP/MCP consumers.

#### Scenario: Tool is registered
- **WHEN** a session tool is added to the canonical registry
- **THEN** the registry entry includes the tool name, API version, input schema, output schema, description, exposure mode, and handler ownership

#### Scenario: Tool lacks output schema
- **WHEN** a tool does not declare an explicit output schema
- **THEN** the tool is not exposed through the native registry or the session MCP server

### Requirement: Runtime validation uses the canonical contract
The system SHALL validate session tool inputs and outputs at runtime using the same canonical schemas used to derive TypeScript and MCP JSON Schema definitions.

#### Scenario: Native consumer calls a tool
- **WHEN** a native TypeScript consumer invokes a session tool
- **THEN** the input and returned output are validated against the canonical schema for that tool version

#### Scenario: Hermes calls a tool through ACP MCP
- **WHEN** Hermes invokes a session tool received through ACP `session.mcpServers`
- **THEN** the session MCP bridge validates the input and returned output against the canonical schema for that tool version

### Requirement: Native and ACP MCP catalogs are validated in CI
The system SHALL include a CI contract check that compares the native session tool catalog with the catalog exposed through the ACP/MCP bridge used by Hermes.

#### Scenario: Catalogs match
- **WHEN** CI extracts the native catalog and lists tools from the session MCP bridge
- **THEN** each exposed tool has matching name, API version, input schema, output schema, and exposure metadata

#### Scenario: Catalogs diverge
- **WHEN** a tool exists only in the native catalog, exists only in the ACP/MCP catalog, or has a different schema between catalogs
- **THEN** the CI contract check fails before the change can be merged

### Requirement: New tools require contract approval before exposure
The system SHALL block new session tools from being exposed unless they pass an approval gate for frontier API contract completeness.

#### Scenario: Pull request adds a new tool
- **WHEN** a pull request adds or exposes a new session tool
- **THEN** the approval gate verifies the tool uses the canonical registration entry point, declares its API version, declares input and output schemas, and is covered by native and ACP/MCP contract tests

#### Scenario: Pull request bypasses canonical registration
- **WHEN** a pull request exposes a session tool outside the canonical registration entry point
- **THEN** the approval gate fails and reports that the tool must be registered through the frontier API contract

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

### Requirement: Browser element refs are invalidated by navigation

Refs `@eN` do snapshot de acessibilidade SHALL ser válidas apenas dentro do
documento em que foram capturadas. Navegação (`did-navigate`) e navegação
in-page (`did-navigate-in-page`) SHALL invalidar todas as refs correntes
(incluindo o mapa estável `backendNodeId → ref`). Ações (`click`/`fill`/
`select`) com ref inválida ou stale SHALL falhar com erro instruindo a rodar
`browser_snapshot` primeiro. Números de ref SHALL NOT ser reutilizados após
invalidação (contador monotônico), de modo que uma ref pré-navegação nunca
resolva para um elemento pós-navegação.

#### Scenario: ref usada após navegação é rejeitada

- **GIVEN** um snapshot capturou a ref `@e1` numa página
- **WHEN** a página navega (full ou in-page) e o agente age sobre `@e1` sem novo snapshot
- **THEN** a ação falha com erro de ref stale citando `browser_snapshot`

#### Scenario: ref pré-navegação não colide após novo snapshot

- **GIVEN** a página navegou e um novo snapshot foi capturado
- **WHEN** o agente usa uma ref do snapshot antigo
- **THEN** a ação falha com erro de ref stale (o número da ref antiga não foi reutilizado)

#### Scenario: ref fresca funciona

- **GIVEN** um snapshot recém-capturado do documento atual
- **WHEN** o agente age sobre uma ref desse snapshot
- **THEN** a ação resolve o elemento correto normalmente

### Requirement: Remote browser bridge timeout never undercuts the action timeout

O bridge de browser remoto (server → desktop client) SHALL usar um budget de
transporte derivado do `timeoutMs` da ação (com margem e teto), de modo que o
transporte nunca desista antes da ação remota completar — eliminando o replay
de ação (double-submit). O `timeoutMs` aceito pelo runtime de browser tools
SHALL ter teto. Quando o timeout de transporte ainda assim ocorrer, a mensagem
de erro SHALL avisar que a ação pode ter sido executada e recomendar
`browser_snapshot` antes de repetir.

#### Scenario: click com timeout maior que o budget default não causa replay

- **GIVEN** um agente remoto chama `browser_click … navigation 60000`
- **WHEN** o bridge envia a invocação ao desktop client
- **THEN** o budget de transporte é ≥ 60s + margem (não os 30s default)
- **AND** o resultado real do click chega ao agente em vez de um timeout falso

#### Scenario: timeoutMs acima do teto é clampado

- **GIVEN** um agente passa `timeoutMs` acima do teto do runtime
- **WHEN** a ação é executada
- **THEN** o timeout efetivo é o teto (e o budget de transporte respeita seu próprio teto)

#### Scenario: mensagem de timeout avisa sobre possível execução

- **GIVEN** uma invocação de browser remota expira no transporte
- **WHEN** o erro é propagado ao agente
- **THEN** a mensagem contém o aviso de que a ação pode ter sido executada e a recomendação de rodar `browser_snapshot` antes de repetir

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

