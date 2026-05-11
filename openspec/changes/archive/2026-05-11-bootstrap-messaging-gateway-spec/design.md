## Context

O `messaging-gateway` já existe como camada de integração entre canais externos e sessões Craft. O pacote `packages/messaging-gateway` centraliza registry por workspace, stores de configuração e bindings, pairing, roteamento inbound, comandos de chat, renderização de respostas e fanout de eventos de sessão. O pacote `packages/messaging-whatsapp-worker` executa o WhatsApp fora do processo principal via Baileys e protocolo NDJSON.

O host cria o gateway por `createMessagingBootstrap`, injeta `sessionManager`, `credentialManager`, diretórios de storage e worker WhatsApp, registra o registry em `HandlerDeps` e compõe o sink de eventos com `createFanOutSink`. A UI e o RPC operam contra a interface `IMessagingGatewayRegistry`, incluindo configuração, bindings, pairing e ações de conexão/desconexão.

## Goals / Non-Goals

**Goals:**

- Registrar o contrato arquitetural retroativo do gateway central: registry → pairing → binding → router → fanout.
- Definir o worker WhatsApp como subprocesso isolado, com Baileys, filtros de protocolo e pareamento por QR ou código.
- Documentar storage de bindings e configuração por workspace.
- Documentar como mensagens externas chegam às sessões internas e como respostas da sessão retornam ao canal.
- Documentar comandos suportados pelo gateway.

**Non-Goals:**

- Alterar implementação, código de produto, UI ou testes.
- Especificar canais ainda não implementados além do contrato de registry para extensibilidade.
- Tornar WhatsApp uma API oficial ou assumir estabilidade do protocolo Baileys.

## Decisions

### Registry por workspace

O sistema usa `MessagingGatewayRegistry` como dono dos gateways por workspace. Ele inicializa `MessagingGateway`, `ConfigStore`, `BindingStore`, adapters de plataforma e runtime status, e expõe a interface usada pelo RPC.

Alternativa considerada: instanciar adapters diretamente nos handlers RPC. Isso espalharia lifecycle, storage e eventos por várias camadas, então o registry fica como ponto único de orquestração.

### Storage app-owned por workspace

O storage de mensageria é recebido por `getMessagingDir(workspaceId)`. O gateway persiste `config.json` e `bindings.json` nesse diretório, com migração opcional de diretório legado. Bindings incluem `workspaceId`, `sessionId`, `platform`, `channelId`, `channelName`, `enabled`, `createdAt` e config normalizada.

Alternativa considerada: guardar vínculos apenas em memória. Isso quebraria reinícios e impossibilitaria a UI de refletir conexões persistidas.

### Pairing explícito antes de bind

O pareamento usa códigos temporários gerados a partir da sessão no app e consumidos pelo canal externo com `/pair <code>`. Os códigos têm TTL, são de uso único, ficam em memória e possuem rate limit por workspace e por remetente.

Alternativa considerada: criar bind automaticamente ao receber primeira mensagem do canal. Isso ligaria um canal externo a uma sessão sem confirmação explícita do usuário.

### Router depois dos filtros de protocolo

Workers/adapters normalizam e filtram mensagens antes de emitir `IncomingMessage`. O router recebe apenas mensagens aceitas pelo protocolo, resolve o binding por `platform` e `channelId`, transforma anexos locais quando presentes e chama `SessionManager.sendMessage`.

Alternativa considerada: deixar todo filtro para o router. Isso faria o gateway central conhecer detalhes de Baileys, eco de self-chat, histórico sincronizado e formatos específicos de cada canal.

### Fanout para respostas de sessão

O host compõe o sink de eventos com `createFanOutSink`, mantendo o push RPC existente e adicionando o gateway como consumidor de eventos de sessão. O gateway renderiza eventos relevantes da sessão para cada binding aplicável.

Alternativa considerada: polling das sessões pelo gateway. Isso aumentaria latência e duplicaria estado que já é emitido pelo `SessionManager`.

### WhatsApp isolado em subprocesso

O adapter WhatsApp faz spawn do worker `@craft-agent/messaging-whatsapp-worker`. O worker concentra Baileys, auth state multi-file, reconexão, filtros de inbound, envio e pareamento, comunicando-se com o processo principal por NDJSON em stdin/stdout.

Alternativa considerada: carregar Baileys dentro do processo principal Electron/Bun. O subprocesso reduz acoplamento, mantém stdout parseável, isola crashes e permite runtime Node quando o host não for Node.

### Credenciais fora de logs

Tokens de canais com bearer, como Telegram, passam pelo `CredentialManager`. O auth state do WhatsApp fica em diretório local de mensageria por workspace (`whatsapp-auth`). Eventos de QR e pairing são enviados como eventos estruturados para UI, enquanto logs registram presença do evento e metadados operacionais, não o segredo em si.

Alternativa considerada: persistir QR, pairing token ou bearer em `config.json`. Isso ampliaria exposição em arquivos e logs operacionais.

## Risks / Trade-offs

- Baileys é API não oficial → manter worker isolado, status `unavailable`/`reconnect_required` e ação de `forget` para limpar auth state quando necessário.
- Bindings em arquivo local podem corromper → carregar de forma defensiva, resetar para vazio em falha de parse e emitir logs estruturados.
- Códigos de pairing são curtos → aplicar TTL, consumo único e rate limit por workspace/remetente.
- Fanout pode duplicar eventos se registrado mais de uma vez → hosts devem passar por `createMessagingBootstrap` e compor o sink uma única vez.
- Filtros específicos de canal podem descartar mensagem esperada → manter filtros testáveis no worker e documentar os sinais usados (`sender`, grupo/self-chat, tag/prefixo, histórico).

## Migration Plan

Esta change é retroativa e não requer migração de runtime. O design formaliza a implementação existente.

Para mudanças futuras:

- Atualizar a capability antes de alterar contrato de storage, pairing, router, fanout, comandos ou worker.
- Preservar migração one-shot de diretórios legados quando o storage mudar.
- Validar unit tests do gateway e filtros do worker antes de release.

## Open Questions

- Quais canais adicionais devem entrar no registry primeiro além de Telegram e WhatsApp.
- Se filtros por `group` e `tag` devem virar configuração persistida por binding ou continuar como política de adapter/worker.
- Se QR/pairing code deve ter UX dedicada no Hermes Messengers tab ou somente na página de Messaging settings.
