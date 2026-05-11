## Why

`packages/messaging-whatsapp-worker/` existe como pacote separado para um unico adapter, com poucos arquivos e sem API independente alem do protocolo privado consumido pelo `WhatsAppAdapter` do gateway. Isso cria um seam imaginario: com um adapter, a fronteira de package parece extensibilidade real, mas so adiciona wiring, dependencia workspace e um ponto extra de drift.

O gateway ja e o owner natural de descoberta, lifecycle, dispatch, pairing, bindings e fanout de canais. Telegram ja vive em `packages/messaging-gateway/src/adapters/telegram/`; WhatsApp deve seguir o mesmo modelo em `packages/messaging-gateway/src/adapters/whatsapp/`, mantendo isolamento de subprocesso para Baileys sem manter um package proprio.

## What Changes

- Mover o conteudo de `packages/messaging-whatsapp-worker/` para `packages/messaging-gateway/src/adapters/whatsapp/`, preservando a semantica de `worker`, `protocol` e `filter`.
- Criar um `MessageAdapterRegistry` dentro de `messaging-gateway` para possuir descoberta, registro e dispatch de adapters por canal.
- Atualizar o `WhatsAppAdapter` para importar protocolo/filtro internamente, sem depender de `@craft-agent/messaging-whatsapp-worker`.
- Remover o package `packages/messaging-whatsapp-worker` e sua entrada de workspace/dependencia.
- Manter o contrato de isolamento: WhatsApp continua rodando Baileys em subprocesso; apenas o codigo deixa de viver em package separado.

## Capabilities

### New Capabilities

Vazio.

### Modified Capabilities

- `messaging-gateway`: adiciona o contrato de `MessageAdapterRegistry` e da estrutura interna `src/adapters/<channel>/` para adapters de canal.

## Impact

- `packages/messaging-whatsapp-worker`: deletado como package independente.
- `packages/messaging-gateway`: incorpora worker/protocolo/filtro WhatsApp, registry unificado e dispatch de adapters.
- Root workspaces e dependencias internas: removem a referencia ao worker separado.
- Testes do worker: movidos para o gateway junto do adapter WhatsApp.
