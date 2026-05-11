## 1. Fold-back WhatsApp

- [x] Criar `packages/messaging-gateway/src/adapters/whatsapp/`
- [x] Mover arquivos do worker mantendo estrutura semantica
- [x] Atualizar `WhatsAppAdapter` para importar `./protocol` e arquivos locais
- [x] Registrar o novo worker entry interno no build/packaging

## 2. Registry unificado

- [x] Definir `MessageAdapterRegistry` em `packages/messaging-gateway/src/registry.ts` ou modulo similar
- [x] Registrar WhatsApp no registry
- [x] Registrar Telegram e futuros adapters pelo mesmo contrato
- [x] Atualizar `router.ts`/gateway wiring para usar registry no dispatch de adapters

## 3. Workspaces e consumers

- [x] Atualizar root `package.json` para remover o workspace `packages/messaging-whatsapp-worker`
- [x] Atualizar `packages/messaging-gateway/package.json` para remover `@craft-agent/messaging-whatsapp-worker`
- [x] Atualizar imports em consumers
- [x] Deletar `packages/messaging-whatsapp-worker`

## 4. Spec e validacao

- [x] Mover testes existentes do worker junto do adapter WhatsApp
- [x] Adicionar contract test do registry
- [x] Atualizar spec `messaging-gateway`
- [x] Rodar validacao OpenSpec da change
