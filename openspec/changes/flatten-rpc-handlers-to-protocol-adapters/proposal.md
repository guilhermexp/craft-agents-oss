## Why

Os handlers RPC em `packages/server-core/src/handlers/rpc/` misturam adapter de protocolo com responsabilidades de manager. Muitos handlers fazem apenas parse do payload IPC, chamam um manager e retornam a resposta, mas alguns também mantêm estado local como watchers, timers, caches de processos e contexto por client.

Essa mistura aumenta o custo dos testes: testar um handler exige fixture pesada de RPC, timers, filesystem e push events, mesmo quando a regra real pertence ao manager. Também espalha ownership de recursos de longa duração por módulos que deveriam só traduzir entrada e saída do protocolo.

## What Changes

- Transformar handlers RPC em adapters puros: parse IPC payload -> chamada de método do manager correspondente -> retorno da resposta.
- Remover estado local persistente dos handlers RPC.
- Mover watchers, debounce timers, processos, caches e contexto por client para managers ou serviços de domínio explícitos.
- Fazer push events saírem do manager/serviço dono do estado, usando event sink ou mecanismo equivalente, sem callback escondido no handler.
- Manter handlers testáveis com managers mockados; testes de lifecycle, watchers e timers ficam nos managers/serviços.

## Capabilities

### Modified Capabilities

- `session-management`: passa a declarar que estado por client de sessões, watchers de arquivos, debounce, fallback de erro de streaming e transferências vinculadas a sessão pertencem ao `SessionManager` ou serviço controlado por ele, não ao RPC handler.
- `channels-war-room`: passa a declarar que orquestradores de canal, watchers de Kanban e timers de polling pertencem ao manager/orchestrator de canais, não ao RPC handler.
- `hermes-embed`: passa a declarar que dashboard Hermes, watcher de auth/update marker, tokens de sessão, subprocessos e timers pertencem a um manager/serviço Hermes, não ao RPC handler.

## Impact

- `packages/server-core/src/handlers/rpc/*`: simplificação para adapters sem estado local persistente.
- `packages/server-core/src/sessions/SessionManager.ts`: absorve ou delega explicitamente estado por client de sessão, file watching e transferências de sessão.
- `packages/server-core/src/channels/*`: concentra lifecycle de `ChannelOrchestrator`, watchers de Kanban e emissão de eventos de mensagens.
- `packages/server-core/src/handlers/rpc/hermes.ts` ou novo serviço Hermes: extrai lifecycle do dashboard, auth watcher e update monitor para fora do handler.
- Testes de handlers passam a usar manager mockado; testes de integração permanecem nos managers/serviços donos do estado.
