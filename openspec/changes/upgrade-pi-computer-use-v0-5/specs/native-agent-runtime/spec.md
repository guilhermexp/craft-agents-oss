## MODIFIED Requirements

### Requirement: Native runtime keeps Pi computer-use scoped to Pi

O runtime nativo SHALL expor a extensão vendorizada `pi-computer-use` somente ao backend Pi desktop suportado e SHALL distribuir no aplicativo Electron um recurso autossuficiente, capaz de operar sem o checkout do monorepo.

#### Scenario: Pi macOS exposes the v0.5 tool contract

- **WHEN** uma sessão Pi desktop inicia no macOS com `enableComputerUse`, o pacote vendorizado está disponível e o helper possui as permissões necessárias
- **THEN** o subprocesso Pi MUST carregar a extensão e permitir `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`, `launch_browser`, `navigate_browser` e `evaluate_browser`
- **AND** ele MUST NOT anunciar os tools públicos legados `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text` ou `computer_actions`
- **Test:** `packages/pi-agent-server/src/session-tool-registration.test.ts` e smoke real da task 4.3

#### Scenario: Computer-use is disabled

- **WHEN** `enableComputerUse` é falso, a sessão não é Pi ou a plataforma não é macOS
- **THEN** o runtime MUST NOT adicionar o pacote nem os nomes de tools computer-use à sessão
- **Test:** testes focados de registro/resource loader em `packages/pi-agent-server/src/`

#### Scenario: Packaged Electron resource is self-contained

- **WHEN** o Pi server inicia a partir de `resources/pi-agent-server` no aplicativo empacotado
- **THEN** ele MUST encontrar a extensão v0.5, seus assets e dependências runtime sem resolver módulos a partir do `node_modules` do checkout
- **Test:** teste isolado de packaging e inspeção do artefato gerado na task 3.3

#### Scenario: Vendored extensions compose

- **WHEN** `pi-better-subagents` e `pi-computer-use` estão presentes e habilitados para a mesma sessão Pi
- **THEN** o resource loader único MUST carregar ambas e a allowlist MUST preservar os nomes de tools das duas extensões sem duplicatas
- **Test:** teste focado de resource loader/registro criado na task 1.3

#### Scenario: Authorized helper performs a real action

- **WHEN** o helper macOS instalado possui Accessibility e Screen Recording e uma sessão Pi observa um documento temporário do TextEdit
- **THEN** `observe_ui` MUST produzir estado real e captura não preta, e `act_ui` MUST produzir uma mutação temporária confirmável por nova observação
- **Test:** smoke real da task 4.3, fechando o documento sem salvar

#### Scenario: Claude and Hermes exclude Pi computer-use

- **WHEN** o backend Claude ou a integração Hermes inicia
- **THEN** ele MUST NOT receber pacote, allowlist ou configuração de ferramentas `computer-use` do Pi
- **Test:** testes existentes de isolamento de backend e teste desabilitado da task 1.3
