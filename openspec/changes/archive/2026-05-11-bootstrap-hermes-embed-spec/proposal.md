## Why

Documentar retroativamente a capability Hermes embed: o runtime Python/ACP do Hermes já é embutido no Electron, isolado por `HERMES_HOME` app-scoped e atualizado por pin upstream mais patches overlay. Formalizar esse contrato no OpenSpec reduz drift em futuras mudanças de runtime, auth, bundle, seed e RPC.

## What Changes

- Adicionar a nova capability `hermes-embed` para descrever o estado atual do Hermes embutido no Craft.
- Cobrir bundling do runtime Python/ACP em `apps/electron/resources/vendor/hermes`.
- Cobrir seed de skills do Hermes em `resources/hermes-seed` com cópia conservadora para `HERMES_HOME`.
- Cobrir auth bridge Craft → Hermes e sincronização de tokens Codex atualizados.
- Cobrir configuração ACP, incluindo `session.mcpServers` para `craft-session` e `craft-sources`.
- Cobrir handler RPC do Hermes para detecção, dashboard, update em dev, arquivos/logs/skills, profiles, providers e validação de caminhos.

## Capabilities

### New Capabilities

- `hermes-embed`: Runtime Hermes Python/ACP embutido no Craft Electron, com estado app-scoped, seed bootstrap, auth bridge, MCPs de sessão e empacotamento.

### Modified Capabilities

## Impact

- `apps/electron`: main process, scripts de bundle/update/package, recursos vendorizados, seed resources e documentação operacional.
- `packages/shared/src/hermes/`: config ACP, runtime config, seed bootstrap e auth bridge.
- `packages/shared/src/agent/hermes-agent.ts`: spawn ACP stdio, env do runtime, auth bridge e MCPs de sessão.
- `packages/server-core/src/handlers/rpc/hermes.ts`: detecção do runtime, dashboard, update, browsing seguro de arquivos/logs/skills, profiles, provider models e sync de auth.
