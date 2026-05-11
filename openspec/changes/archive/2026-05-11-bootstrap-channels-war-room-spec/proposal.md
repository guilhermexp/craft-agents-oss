## Why

Documentar retroativamente a capability Channels / War Room para que evoluções futuras tenham um contrato escrito sobre salas compartilhadas multi-sessão com orquestração de agentes Hermes/Craft. A implementação já existe em código e documentação operacional, mas precisa virar especificação OpenSpec para preservar o modelo de produto.

## What Changes

- Add new capability `channels-war-room`.
- Registrar o contrato de canais como salas compartilhadas, não apenas labels.
- Registrar CRUD, mensagens, participantes, resolução de menções, roteamento e integração Hermes Kanban.
- Registrar o RPC de canais como fonte da verdade entre cliente e servidor.

## Capabilities

### New Capabilities
- `channels-war-room`: salas compartilhadas com membros, histórico, menções, roteamento para sessões Craft/Hermes e suporte ao modo War Room com Hermes Kanban.

### Modified Capabilities

Nenhuma.

## Impact

- `packages/shared/src/channels`
- `packages/shared/src/protocol/channels.ts`
- `packages/server-core/src/handlers/rpc/channels.ts`
- `packages/server-core/src/channels/*`
- `apps/electron/src/renderer/components/app-shell/ChannelConversationPanel.tsx`
