## Contexto

O worker WhatsApp separado contem a integracao Baileys, o protocolo NDJSON e os filtros puros de inbound. O gateway ja possui `MessagingGatewayRegistry`, `MessagingGateway`, `Router`, `TelegramAdapter` e `WhatsAppAdapter`; a unica fronteira externa real do WhatsApp e o subprocesso, nao o package workspace.

A mudanca proposta e um fold-back: o WhatsApp continua isolado operacionalmente, mas seu codigo passa a morar no mesmo package que registra, inicia, observa e roteia adapters de mensageria.

## Estrutura proposta

Cada canal deve viver sob:

```text
packages/messaging-gateway/src/adapters/<channel>/
  index.ts
  worker.ts
  protocol.ts
  filter.ts
```

Para canais que nao precisam de subprocesso, `worker.ts` pode nao existir. A convencao esperada e:

- `index.ts`: adapter que implementa `PlatformAdapter` e traduz eventos do canal para `IncomingMessage`.
- `worker.ts`: entrypoint isolado quando o canal precisa de processo proprio.
- `protocol.ts`: contrato privado entre adapter e worker, quando existir.
- `filter.ts`: filtros de protocolo que impedem mensagens fora de escopo de chegar ao `Router`.

No WhatsApp, `worker.ts`, `protocol.ts` e `filter.ts` devem ser copiados do package atual para `src/adapters/whatsapp/`, e `index.ts` deve importar `./protocol` em vez de `@craft-agent/messaging-whatsapp-worker`.

## MessageAdapterRegistry

Criar um `MessageAdapterRegistry` dentro de `messaging-gateway` para ser o ponto unico de descoberta e dispatch dos adapters de canal.

Contrato proposto:

- Registrar factories por `PlatformType`.
- Validar que so existe um adapter ativo por plataforma por workspace.
- Construir adapters a partir da configuracao persistida e credenciais resolvidas.
- Encapsular o dispatch de lifecycle: initialize, register no `MessagingGateway`, unregister e destroy.
- Expor leitura de runtime/capabilities sem o caller conhecer paths ou detalhes de cada adapter.

O registry nao substitui o `Router`: ele decide quais adapters existem e quando estao conectados; o `Router` continua decidindo se uma mensagem vai para sessao ou para comandos.

## Migration

1. Criar `packages/messaging-gateway/src/adapters/whatsapp/worker.ts`, `protocol.ts` e `filter.ts` com o conteudo atual do worker.
2. Atualizar imports do `WhatsAppAdapter` para usar arquivos locais.
3. Ajustar o build/packaging para apontar o worker entry dentro de `messaging-gateway`.
4. Remover `@craft-agent/messaging-whatsapp-worker` de `packages/messaging-gateway/package.json`.
5. Remover `packages/messaging-whatsapp-worker` do root workspace e deletar o package.
6. Atualizar todos os consumers que referenciam o package antigo para o novo entrypoint do gateway.

## Tests

- Mover os testes atuais de filtro do worker para `packages/messaging-gateway/src/adapters/whatsapp/filter.test.ts`.
- Manter/ajustar os testes de lifecycle do `WhatsAppAdapter` para validar o subprocesso com o novo entrypoint interno.
- Adicionar contract test do `MessageAdapterRegistry` cobrindo:
  - descoberta/registro de WhatsApp e Telegram;
  - dispatch de initialize/destroy;
  - prevencao de adapter duplicado por plataforma;
  - exposicao de capabilities/runtime por plataforma.
- Rodar os testes focados do gateway apos a migracao.

## Trade-offs

Remover o package reduz modularidade aparente, mas nao remove uma API real: nao havia consumer externo independente, e o protocolo do worker era privado do adapter WhatsApp. Em troca, o gateway passa a ter uma fronteira mais honesta: um package para mensageria, adapters internos por canal e isolamento de subprocesso apenas onde o runtime exige.

O risco principal e ajustar packaging/build paths do worker. A mitigacao e manter `worker.ts` como entrypoint explicito e cobrir o caminho com teste de lifecycle e validacao de bundle.
