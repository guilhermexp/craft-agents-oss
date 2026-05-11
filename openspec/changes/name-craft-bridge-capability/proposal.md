## Why

A integração com Craft existe materialmente, mas hoje não tem fronteira nomeada: o README anuncia Craft MCP para ferramentas de documentos, o código valida URLs `mcp.craft.do`, e o OAuth de MCP trata Craft como caso dentro do fluxo genérico. Isso torna ambígua a resposta para "onde fica a auth Craft, a source Craft e o roteamento de contexto Craft?".

## What Changes

- Introduzir a capability `craft-bridge` para nomear o limite de integração com o produto Craft via MCP.
- Declarar que auth Craft MCP, validação de URLs Craft MCP e exposição de contexto/documentos Craft pertencem ao bridge, mesmo que a primeira implementação seja extração de código existente.
- Separar `workspace-and-sources`: sources continuam genéricas, mas uma source MCP apontando para Craft deve ser classificada e delegada ao `craft-bridge`.
- Separar `channels-war-room`: canais continuam salas genéricas; qualquer roteamento com contexto/documentos Craft deve ser explícito como integração do `craft-bridge`, não comportamento implícito do War Room.
- Não mover WhatsApp, Slack, Google Meet, GitHub, Google Drive ou OAuth genérico para essa capability.

## Capabilities

### New Capabilities

- `craft-bridge`: Integração nomeada com o produto Craft via MCP, incluindo auth Craft MCP, validação de endpoint Craft, contexto/documentos Craft e contratos de roteamento para sessões Craft.

### Modified Capabilities

- `workspace-and-sources`: Separar fontes genéricas de sources Craft MCP e direcionar responsabilidades específicas de Craft para `craft-bridge`.
- `channels-war-room`: Deixar explícito que canais são genéricos e só podem usar contexto Craft por meio de contrato nomeado do `craft-bridge`.

## Impact

- Código afetado em implementação futura: `packages/shared/src/auth/oauth.ts`, `packages/shared/src/sources/credential-manager.ts`, `packages/shared/src/validation/url-validator.ts`, `packages/shared/src/sources/`, e pontos de sessão que registram `craft-agents-docs`.
- Specs afetadas: nova capability `craft-bridge`, mais deltas em `workspace-and-sources` e `channels-war-room`.
- Sem dependência nova prevista; a mudança é principalmente de ownership arquitetural e extração/renomeação.
- Risco principal: confundir Craft Agents Docs (`agents.craft.do/docs/mcp`) com documentos do produto Craft (`mcp.craft.do/links/.../mcp`). A proposta exige essa distinção.
