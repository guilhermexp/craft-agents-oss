## Why

Documentar retroativamente a capability `messaging-gateway` para que o registry de canais externos, o pareamento, o binding store, o router e o fanout para workers de canal tenham contrato escrito. Isso dá base para mudanças futuras no gateway e no worker WhatsApp dedicado sem depender apenas do código existente.

## What Changes

- Add new capability `messaging-gateway`.

## Capabilities

### New Capabilities

- `messaging-gateway`: Registry de canais externos, pairing, binding store, router, fanout e integração com workers dedicados como WhatsApp.

### Modified Capabilities

Vazio.

## Impact

- `packages/messaging-gateway`
- `packages/messaging-whatsapp-worker`
- Consumidores UI, incluindo a aba Hermes Messengers
- RPC de mensageria exposto pelo server-core
