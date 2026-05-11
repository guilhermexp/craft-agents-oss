## Why

A capability `meetings` já existe de forma distribuída no desktop, no runtime Hermes vendorizado e nos contratos RPC, mas ainda não tinha um contrato OpenSpec próprio. Esta change documenta retroativamente Google Meet bot embutido, autenticação Google e a aba de arquivos do workspace para que mudanças futuras tenham requisitos escritos antes de alterar comportamento.

## What Changes

- Add new capability `meetings`.
- Documentar o convite do Hermes para Google Meet a partir do BrowserView interno e da página nativa de reuniões.
- Documentar o runtime do Google Meet bot embutido no bundle Hermes vendorizado.
- Documentar a integração de autenticação Google e listagem de arquivos do Drive/Workspace consumíveis pelo Hermes.
- Documentar o ciclo de vida RPC de reunião: iniciar, listar, consultar status, obter transcrição e parar.

## Capabilities

### New Capabilities
- `meetings`: cobre convite do Hermes ao Google Meet, runtime vendorizado do Meet bot, autenticação Google, arquivos de Workspace/Drive e ciclo de vida de reunião como sessão Craft.

### Modified Capabilities
- Nenhuma.

## Impact

- `packages/shared/src/meetings` ou contratos compartilhados equivalentes em `packages/shared/src/protocol`.
- Runtime Hermes vendorizado em `apps/electron/resources/vendor/hermes`, incluindo `plugins/google_meet`.
- Scripts de bundle Hermes em `apps/electron/scripts/bundle-hermes.sh` e equivalentes.
- Handler RPC/IPC de reuniões em `apps/electron/src/main/handlers/meetings.ts` e serviço em `apps/electron/src/main/meetings/meeting-service.ts`.
- UI de reuniões, BrowserView toolbar e workspace files tab no renderer Electron.
- Documentação operacional de Hermes embutido em `apps/electron/docs/hermes-embed.md`.
