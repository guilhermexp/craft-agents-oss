## Why

A capability `session-tools-mcp` ja existe no runtime, mas ainda nao tinha contrato OpenSpec escrito. Documenta-la retroativamente evita que futuras mudancas em tools MCP session-scoped quebrem o isolamento de sessao, a integracao Hermes via ACP ou os contratos de seguranca de source, memoria, renderizacao, transformacao e sandbox.

## What Changes

- Add new capability `session-tools-mcp`.
- Documentar o servidor MCP session-scoped que entrega ferramentas Craft-native aos agentes em runtime.
- Formalizar o contrato das tools de browser, sources, config, memory, sandbox, render, transform, validate, messaging, automations, meetings, LLM e delegacao de sessoes.

## Capabilities

### New Capabilities

- `session-tools-mcp`: ferramentas MCP escopadas a sessao, injetadas no runtime de agentes e consumidas por ACP/MCP.

### Modified Capabilities

Nenhuma.

## Impact

- `packages/session-tools-core`: schemas, registry canonica e handlers das tools session-scoped.
- `packages/session-mcp-server`: empacotamento CJS/stdio para expor as tools via MCP.
- `packages/shared/src/mcp/session-tools-server.ts`: bridge MCP HTTP local usado por Hermes para tools Craft-native.
- `packages/shared/src/agent/hermes-agent.ts`: consumo via ACP `session.mcpServers`.
- Agentes que recebem o servidor `craft-session`, incluindo Hermes, devem preservar os nomes canonicos e o escopo da sessao ativa.
