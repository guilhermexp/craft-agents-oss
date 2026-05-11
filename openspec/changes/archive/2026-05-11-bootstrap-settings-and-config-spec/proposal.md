## Why

Documentar retroativamente a capability `settings-and-config` para que as settings tabs do Electron e a camada `packages/shared/src/config` tenham contrato escrito antes de novas mudanças.

Essa capability cobre o comportamento já existente de preferences, themes, storage, migrations, conexões LLM e configurações por app/workspace, reduzindo regressões em alterações futuras.

## What Changes

- Add new capability `settings-and-config`.
- Define o contrato das tabs de settings no Electron: env/app, messengers, skills, logs, AI, input, labels, permissions, server, workspace e Hermes.
- Define persistência imediata de settings, sem botão global de salvar.
- Define contratos para preferences, theme live update, storage local, migrations versionadas, validação de LLM connections e regressões de modelos customizados Hermes.

## Capabilities

### New Capabilities

- `settings-and-config`: cobre settings tabs do Electron, preferences/themes/storage/migrations em `packages/shared/src/config`, handlers RPC de settings/LLM/Hermes e validações associadas.

### Modified Capabilities

- Nenhuma.

## Impact

- `packages/shared/src/config`: preferences, theme, storage, validators, LLM connections, migrations e default thinking level.
- `apps/electron/src/renderer/pages/settings`: páginas de settings e subconfigurações Hermes.
- `packages/server-core/src/handlers/rpc`: handlers de settings, LLM connections, server, messaging, labels, skills e Hermes.
- Validação de CI relacionada a i18n parity via `lint:i18n:parity`.
