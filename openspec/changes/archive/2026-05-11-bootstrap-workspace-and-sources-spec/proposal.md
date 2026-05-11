## Why

Documentar retroativamente a capability `workspace-and-sources` para que workspaces locais/remotos e sources MCP/API/filesystem tenham contrato escrito antes de novas mudanças. Isso reduz regressões em criação de workspace, conexão remota, credenciais, validação de sources e boundary de filesystem.

## What Changes

- Add new capability `workspace-and-sources`.
- Define workspaces como abstrações de pasta de trabalho local ou remota, com configuração própria.
- Define sources como conexões externas MCP, API ou filesystem, com autenticação, validação de conexão e escopo por workspace.
- Documenta o contrato de OAuth e armazenamento seguro de tokens fora da config do workspace.

## Capabilities

### New Capabilities

- `workspace-and-sources`: cobre workspaces locais/remotos, sources MCP/API/filesystem, OAuth por provider, validação de conexão, boundary de filesystem e workspace picker UI.

### Modified Capabilities

- Nenhuma.

## Impact

- `packages/shared/src/workspaces`
- `packages/shared/src/sources`
- `packages/server-core/src/handlers/rpc/workspace.ts`
- `packages/server-core/src/handlers/rpc/sources.ts`
- Renderer pages e componentes relacionados a workspace picker e sources.
