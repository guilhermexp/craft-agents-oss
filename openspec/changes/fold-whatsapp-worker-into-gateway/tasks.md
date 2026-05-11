## 1. Fold-back WhatsApp

- [ ] Criar `packages/messaging-gateway/src/adapters/whatsapp/`
- [ ] Mover arquivos do worker mantendo estrutura semantica
- [ ] Atualizar `WhatsAppAdapter` para importar `./protocol` e arquivos locais
- [ ] Registrar o novo worker entry interno no build/packaging

## 2. Registry unificado

- [ ] Definir `MessageAdapterRegistry` em `packages/messaging-gateway/src/registry.ts` ou modulo similar
- [ ] Registrar WhatsApp no registry
- [ ] Registrar Telegram e futuros adapters pelo mesmo contrato
- [ ] Atualizar `router.ts`/gateway wiring para usar registry no dispatch de adapters

## 3. Workspaces e consumers

- [ ] Atualizar root `package.json` para remover o workspace `packages/messaging-whatsapp-worker`
- [ ] Atualizar `packages/messaging-gateway/package.json` para remover `@craft-agent/messaging-whatsapp-worker`
- [ ] Atualizar imports em consumers
- [ ] Deletar `packages/messaging-whatsapp-worker`

## 4. Spec e validacao

- [ ] Mover testes existentes do worker junto do adapter WhatsApp
- [ ] Adicionar contract test do registry
- [ ] Atualizar spec `messaging-gateway`
- [ ] Rodar validacao OpenSpec da change
