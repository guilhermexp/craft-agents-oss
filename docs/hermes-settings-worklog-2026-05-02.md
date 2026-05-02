# Hermes Settings Worklog - 2026-05-02

## Contexto

O trabalho de hoje concentrou a operacao do Hermes dentro de
`Settings / Hermes`, em abas internas, sem duplicar o dashboard nativo e sem
expor dumps grandes de `HERMES_HOME` na UI.

O objetivo principal foi trazer para o Settings do Craft as configuracoes que
ja existiam no dashboard Hermes, principalmente:

- configuracao de provider e modelo;
- gerenciamento de profiles multi-agente;
- acesso compacto a skills e logs;
- UI mais limpa, sem sombras/contornos duplicados na barra de abas.

## Mudancas de UI

### Settings Hermes em abas

Arquivo principal:

- `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx`

O Settings Hermes foi organizado em abas:

- `Runtime Hermes`
- `Provider & Modelo`
- `Profiles`
- `Skills do Hermes`
- `Logs`

A barra de abas foi ajustada para ficar visualmente embutida no mesmo Settings,
sem sombra ativa duplicada:

- `TabsList` ficou transparente e sem fundo proprio;
- `TabsTrigger` removeu a sombra quando ativo;
- a aba `Profiles` foi adicionada dentro do mesmo Settings Hermes.

### Profiles

Novo componente:

- `apps/electron/src/renderer/pages/settings/HermesProfilesConfig.tsx`

A nova aba `Profiles` permite operar os profiles do dashboard Hermes direto pelo
Craft:

- listar profiles existentes;
- criar profile novo;
- opcao para clonar config do profile default;
- renomear profiles nao-default;
- deletar profiles nao-default com confirmacao;
- copiar comando de setup do profile;
- abrir, editar e salvar o `SOUL.md` de cada profile.

A UI tambem mostra informacoes resumidas por profile:

- nome;
- indicador de `default`;
- indicador de `.env`;
- modelo e provider;
- quantidade de skills;
- path do profile.

## Contrato de API e RPC

### Tipos compartilhados

Arquivo:

- `packages/shared/src/protocol/dto.ts`

Foram adicionados DTOs para a comunicacao renderer -> main -> Hermes:

- `HermesProfileInfo`
- `HermesListProfilesResult`
- `HermesProfileMutationResult`
- `HermesProfileSetupCommandResult`
- `HermesProfileSoulResult`

### Canais RPC

Arquivo:

- `packages/shared/src/protocol/channels.ts`

Novos canais Hermes:

- `hermes:listProfiles`
- `hermes:createProfile`
- `hermes:renameProfile`
- `hermes:deleteProfile`
- `hermes:getProfileSetupCommand`
- `hermes:getProfileSoul`
- `hermes:updateProfileSoul`

### Roteamento local

Arquivo:

- `packages/shared/src/protocol/routing.ts`

Os novos canais Hermes foram marcados como `LOCAL_ONLY_CHANNELS`, porque devem
ser resolvidos pelo processo local do Electron e nao encaminhados para o
workspace remoto.

Tambem foram incluidos como locais os canais ja existentes de config/modelos do
dashboard Hermes:

- `hermes:getApiConfig`
- `hermes:patchApiConfig`
- `hermes:getProviderModels`

### Preload / Electron API

Arquivos:

- `apps/electron/src/shared/types.ts`
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/renderer/playground/mock-utils.ts`

A API exposta ao renderer recebeu os metodos:

- `listHermesProfiles()`
- `createHermesProfile({ name, cloneFromDefault })`
- `renameHermesProfile(name, newName)`
- `deleteHermesProfile(name)`
- `getHermesProfileSetupCommand(name)`
- `getHermesProfileSoul(name)`
- `updateHermesProfileSoul(name, content)`

O playground recebeu mocks para evitar quebra em modo sem backend Hermes.

## Backend Hermes

Arquivo:

- `packages/server-core/src/handlers/rpc/hermes.ts`

Os handlers novos fazem proxy para os endpoints do dashboard Hermes:

- `GET /api/profiles`
- `POST /api/profiles`
- `PATCH /api/profiles/:name`
- `DELETE /api/profiles/:name`
- `GET /api/profiles/:name/setup-command`
- `GET /api/profiles/:name/soul`
- `PUT /api/profiles/:name/soul`

Eles usam a ponte autenticada ja existente do dashboard embutido, preservando o
contrato de isolamento:

- o source of truth continua sendo o dashboard/runtime Hermes;
- Settings nao le diretamente o `HERMES_HOME` para gerenciar profiles;
- o acesso passa pelo mesmo fluxo autenticado usado para provider/modelo.

Foi adicionada normalizacao defensiva para payloads vindos do dashboard:

- converte `is_default` para `isDefault`;
- converte `has_env` para `hasEnv`;
- converte `skill_count` para `skillCount`;
- ignora entradas invalidas sem quebrar a UI.

## Documentacao tecnica atualizada

Arquivo:

- `apps/electron/docs/hermes-embed.md`

A documentacao do embed Hermes agora registra:

- os novos canais RPC de profiles;
- que os endpoints `/api/profiles*` sao acessados via dashboard autenticado;
- que o Settings Hermes agora e organizado nas abas `Runtime Hermes`,
  `Provider & Modelo`, `Profiles`, `Skills do Hermes` e `Logs`.

## Testes e validacao

Arquivo:

- `packages/server-core/src/handlers/rpc/hermes.test.ts`

O teste do dashboard Hermes foi expandido para cobrir:

- presenca do handler `hermes:listProfiles`;
- proxy autenticado para `/api/profiles`;
- normalizacao do payload do dashboard para o DTO do Craft.

Comandos validados:

```bash
bun run typecheck:electron
bun run typecheck:shared
bun test packages/server-core/src/handlers/rpc/hermes.test.ts apps/electron/src/transport/__tests__/channel-map-parity.test.ts
```

Resultado observado: typechecks passaram e os testes focados passaram.

## Observacao operacional de dev

Durante o teste em `bun dev:desktop`, apareceu o erro:

```text
No handler for: hermes:listProfiles
```

Esse erro nao indicava ausencia do handler no codigo. Ele ocorreu porque o
renderer foi atualizado por HMR, mas o processo principal do Electron ja estava
rodando antes dos novos handlers RPC existirem.

Quando canais/handlers RPC novos sao adicionados, e necessario reiniciar o
processo Electron dev por completo:

```bash
Ctrl+C
bun dev:desktop
```

Somente refresh/HMR do renderer nao registra novos handlers no servidor RPC que
ja esta em memoria.

## Arquivos principais tocados

- `apps/electron/src/renderer/pages/settings/HermesSettingsPage.tsx`
- `apps/electron/src/renderer/pages/settings/HermesProfilesConfig.tsx`
- `apps/electron/src/renderer/playground/mock-utils.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/transport/channel-map.ts`
- `packages/server-core/src/handlers/rpc/hermes.ts`
- `packages/server-core/src/handlers/rpc/hermes.test.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/dto.ts`
- `packages/shared/src/protocol/routing.ts`
- `apps/electron/docs/hermes-embed.md`

