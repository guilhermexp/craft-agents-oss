## Why

O seam dashboard Hermes ↔ Electron host não é nomeado hoje. Abrir o dashboard para o usuário Craft passa por Settings, BrowserView genérico, RPC Hermes, runtime Python e auth bridge; com isso, decisões sobre mount/unmount, navegação, token interno, reload e eventos de UI viajam por 3+ arquivos sem owner claro.

Isso torna mudanças simples no que o usuário vê do dashboard Hermes mais caras do que deveriam ser: qualquer ajuste precisa entender simultaneamente `apps/electron/src/main/`, `apps/electron/src/preload/`, `packages/server-core/src/handlers/rpc/hermes.ts` e `packages/shared/src/hermes/auth-bridge.ts`.

## What Changes

- Criar a capability `hermes-dashboard-host` para nomear o host Electron do dashboard Hermes.
- Mover o ownership conceitual de lifecycle da BrowserView, política de navegação/deep-link, handoff de auth sem exposição de credenciais, refresh após restart do runtime e eventos UI Hermes ↔ Craft para essa capability.
- Declarar em `hermes-embed` que o embed continua dono de runtime, seed, bundling, ACP e auth bridge de processo, mas não é o owner do host visual do dashboard.

## Capabilities

### New Capabilities

- `hermes-dashboard-host`: Host Electron dedicado para o dashboard Hermes, com lifecycle visual, navegação permitida, reload, handoff seguro de auth e eventos de UI.

### Modified Capabilities

- `hermes-embed`: Declara fronteira com `hermes-dashboard-host`; runtime/bundling/seed ficam no embed, apresentação do dashboard fica no host.

## Impact

- `apps/electron/src/main/`: novo módulo de host dedicado para BrowserView/BrowserWindow do dashboard Hermes e integração com shutdown/reload.
- `apps/electron/src/preload/`: bridge mínima para comandos/eventos do dashboard quando a toolbar ou o host precisar falar com o renderer.
- `packages/server-core/src/handlers/rpc/hermes.ts`: continua dono de APIs locais do runtime/dashboard, mas delega lifecycle visual e política de navegação ao host dedicado.
