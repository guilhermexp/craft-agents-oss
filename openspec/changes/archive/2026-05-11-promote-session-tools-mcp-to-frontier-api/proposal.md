## Why

`session-tools-mcp` é a fronteira entre agentes nativos, que consomem as tools diretamente via TypeScript, e Hermes, que consome as mesmas capabilities como sistema externo via ACP `session.mcpServers`. Hoje essa fronteira depende de convenção de registro e prefixo `mcp__session__*`, mas não de uma API versionada com contrato validável entre os dois consumidores.

## What Changes

- Promover as session tools a uma API de fronteira versionada, começando por `v1`.
- Exigir schema explícito de input e output para cada tool antes de ela ser exposta a consumidores nativos ou ACP/MCP.
- Tornar o schema canônico validável estaticamente e em runtime, com a mesma definição alimentando TypeScript, MCP JSON Schema e checks de contrato.
- Adicionar validação CI cruzada para comparar o catálogo nativo com o catálogo exposto pelo bridge ACP/MCP usado pelo Hermes.
- Introduzir approval gate para impedir novas tools sem schema, versão e cobertura de contrato.

## Capabilities

### New Capabilities

Nenhuma.

### Modified Capabilities

- `session-tools-mcp`: adiciona requisitos de API versionada, schema explícito de input/output, validação cruzada native/ACP e gate para exposição de novas tools.

## Impact

- `packages/session-tools-core`: registro canônico, schemas, validadores e tipos públicos das tools.
- `packages/session-mcp-server`: empacotamento MCP e exposição de tools derivadas do contrato canônico.
- `packages/shared/src/agent/hermes-agent.ts`: montagem de `craft-session` em ACP `session.mcpServers` para Hermes.
- CI: novo check de contrato, como `lint:tool-contracts`, para validar paridade entre consumidor nativo e bridge ACP/MCP.
- Documentação operacional: `session-tools-mcp` spec e instruções do repo quando a implementação for feita.
