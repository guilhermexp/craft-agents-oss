## Why

O termo "channel" hoje aparece em contextos diferentes sem marcador semântico: salas multi-sessão do War Room, namespaces de RPC/socket, escopos de integração Slack em sources e canais externos de mensageria como WhatsApp/Telegram. Isso torna `grep channel` ruidoso, mistura domínios no mesmo resultado e aumenta o risco de refactors automáticos renomearem contratos errados.

## What Changes

- Renomear os tipos e constantes ambíguos com prefixos de domínio.
- Tratar canais do War Room como `WarRoomChannel` e tipos auxiliares no mesmo namespace semântico.
- Trocar vocabulário de RPC de "channel" para "namespace", por exemplo `RPC_CHANNELS` para `RPC_NAMESPACES` e campos de wire correspondentes quando aplicável.
- Renomear escopos Slack de sources para `SlackChannelScope` ou nome equivalente que deixe claro que se trata de escopo de integração, não sala.
- Renomear canais externos do messaging gateway para nomes de chat/canal por plataforma, como `MessagingChatId`, `ExternalMessagingChannelBinding` ou `WhatsAppChannelId`, conforme o contrato final definido no design.
- Adicionar opaque types para IDs que hoje são `string` indistintas, evitando atribuição acidental entre `WarRoomChannelId`, `RpcNamespace`, `SlackChannelScope`, `MessagingChannelId` e `WhatsAppChannelId`.

## Capabilities

### New Capabilities

Nenhuma.

### Modified Capabilities

- `channels-war-room`: passa a declarar explicitamente que seus canais são salas War Room compartilhadas, com tipos `WarRoom*`.
- `messaging-gateway`: passa a distinguir canais/chats externos de mensageria dos canais War Room e dos namespaces de RPC.
- `workspace-and-sources`: passa a distinguir escopos de integração Slack de canais/salas do produto.

## Impact

- Impacto amplo de rename, mas majoritariamente mecânico.
- Áreas principais: `packages/shared/src/channels`, `packages/shared/src/protocol`, `packages/shared/src/sources`, `packages/messaging-gateway` e `packages/messaging-whatsapp-worker`.
- A migração deve ser feita em lote por contexto, preferencialmente via LSP rename e revisão manual dos pontos críticos.
- Não há migração funcional planejada; o objetivo é reduzir ambiguidade de vocabulário e risco de refactor.
