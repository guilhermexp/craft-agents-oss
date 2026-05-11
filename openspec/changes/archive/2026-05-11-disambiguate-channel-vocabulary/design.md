## Contexto

`channel` está sobrecarregado no monorepo. A mesma palavra representa sala compartilhada do produto, namespace de protocolo, escopo OAuth/API de Slack e chat externo de plataformas de mensageria. O problema é principalmente semântico: o código funciona, mas a navegação e o refactor ficam frágeis porque buscas textuais e renames automáticos misturam domínios independentes.

## Mapa Atual

| Contexto | Arquivos com ocorrência no escopo lido | Exemplos atuais | Sentido real |
| --- | ---: | --- | --- |
| War Room | 6 | `ChannelConfig`, `WorkspaceChannelsConfig`, `ChannelParticipant`, `ChannelRoutingConfig` | Sala compartilhada multi-sessão dentro do Craft |
| RPC/socket | 5 | `MessageEnvelope.channel`, `registeredChannels`, `CHANNEL_NOT_FOUND`, `RPC_CHANNELS.*` | Namespace/rota de protocolo para handlers e eventos |
| Sources Slack | 1 | `SlackService = 'messaging' \| 'channels' \| ...` | Escopo/serviço de integração Slack |
| Messaging gateway | 19 | `ChannelBinding`, `channelId`, `approvalChannel`, `findByChannel` | Chat/canal externo de Telegram/WhatsApp vinculado a sessão |
| WhatsApp worker | 2 | `channelId` no protocolo NDJSON, self-JID como channel | JID/chat WhatsApp usado pelo worker |

No escopo lido, `rg` encontrou 28 arquivos com vocabulário `channel` nos diretórios relevantes. Isso explica os false positives: o mesmo grep retorna sala War Room, campo de envelope RPC, escopo Slack e identificador externo de chat.

## Colisões Observadas

- `ChannelConfig.id` e `ChannelBinding.channelId` são `string`, mas representam entidades incompatíveis.
- `MessageEnvelope.channel` parece canal de produto, mas é rota/namespace RPC.
- `registeredChannels` descreve handlers registrados no servidor, não salas ou chats.
- `SlackService = 'channels'` parece entidade Slack concreta, mas é um seletor de escopo/serviço para source OAuth/API.
- `approvalChannel` no gateway significa local de aprovação (`chat` ou `app`), não canal de sala.

## Naming Proposto

| Nome velho | Nome novo proposto | Justificativa |
| --- | --- | --- |
| `ChannelConfig` | `WarRoomChannel` | Marca o domínio de sala compartilhada do Craft. |
| `WorkspaceChannelsConfig` | `WorkspaceWarRoomChannelsConfig` | Evita confusão com canais externos e namespaces. |
| `ChannelParticipant` | `WarRoomParticipant` | Participante pertence à sala War Room. |
| `ChannelRoutingConfig` | `WarRoomRoutingConfig` | Roteamento é específico da sala War Room. |
| `CreateChannelInput` | `CreateWarRoomChannelInput` | Entrada de CRUD de sala War Room. |
| `UpdateChannelInput` | `UpdateWarRoomChannelInput` | Entrada de CRUD de sala War Room. |
| `channelId` em War Room | `warRoomChannelId` com `WarRoomChannelId` | Impede misturar ID de sala com ID de chat externo. |
| `RPC_CHANNELS` | `RPC_NAMESPACES` | O contrato de protocolo usa namespaces de handler/evento. |
| `MessageEnvelope.channel` | `rpcNamespace` ou `namespace` | Campo identifica rota RPC, não sala. |
| `registeredChannels` | `registeredNamespaces` | Handshake anuncia namespaces disponíveis. |
| `CHANNEL_NOT_FOUND` | `NAMESPACE_NOT_FOUND` | Erro fica alinhado ao domínio RPC. |
| `SlackService` valor `channels` | `SlackChannelScope` ou `SlackServiceScope` | Deixa claro que é escopo de integração Slack. |
| `ChannelBinding` no gateway | `ExternalMessagingChannelBinding` ou `MessagingChatBinding` | Binding liga chat/canal externo a sessão Craft. |
| `channelId` no gateway | `messagingChannelId` com `MessagingChannelId` | Diferencia chat/canal externo de War Room. |
| `channelId` no WhatsApp worker | `whatsAppChannelId` com `WhatsAppChannelId` | Campo representa JID/chat WhatsApp. |
| `approvalChannel` | `approvalSurface` | O valor é superfície de aprovação, não canal. |
| `findByChannel` | `findByMessagingChannel` ou `findByExternalChannel` | Busca binding por chat/canal externo. |

## Opaque Types

Adicionar um helper de opaque type em módulo compartilhado já existente ou novo módulo de tipos leves:

```ts
type Opaque<T, Brand extends string> = T & { readonly __brand: Brand }
```

IDs candidatos:

- `WarRoomChannelId = Opaque<string, "WarRoomChannelId">`
- `RpcNamespace = Opaque<string, "RpcNamespace">`
- `MessagingChannelId = Opaque<string, "MessagingChannelId">`
- `WhatsAppChannelId = Opaque<string, "WhatsAppChannelId">`
- `SlackChannelScope = Opaque<string, "SlackChannelScope">` quando o valor cruzar boundaries; se ficar como union literal interna, a union pode bastar.

As conversões de boundary devem acontecer em parsers/validadores ou factories, não via cast espalhado.

## Migration

1. Catalogar todas as ocorrências de `channel` no monorepo e classificar por domínio.
2. Fechar a tabela de nomes finais antes de editar.
3. Renomear um contexto por vez via LSP: War Room, RPC, sources Slack, messaging gateway e WhatsApp worker.
4. Após cada contexto, revisar manualmente exports públicos, DTOs, handlers RPC, persistência e textos de UI/logs.
5. Adicionar opaque types nos boundaries onde IDs atravessam módulos ou persistência.
6. Atualizar specs e docs após o rename, mantendo compatibilidade de dados persistidos quando necessário.

## Tests

Nenhum teste novo é necessário apenas para o rename semântico. A validação esperada é rodar a suíte existente após os renames:

- Testes focados de channels/War Room.
- Testes de protocolo/transport que cobrem o mapa de RPC.
- Testes de sources quando o tipo Slack mudar.
- Testes do messaging gateway e WhatsApp worker.
- Typecheck amplo para garantir que opaque types não quebraram boundaries sem conversão explícita.

## Trade-offs

- O PR tende a ser grande, mas mecânico e revisável por domínio.
- Manter aliases temporários reduziria churn imediato, mas prolongaria a ambiguidade.
- Opaque types adicionam conversões explícitas em boundaries; isso aumenta fricção pequena agora e reduz bugs de string trocada depois.
- Renomear campos persistidos pode exigir compatibilidade de leitura; onde o campo for storage externo, preferir migrador ou alias de leitura temporário.
