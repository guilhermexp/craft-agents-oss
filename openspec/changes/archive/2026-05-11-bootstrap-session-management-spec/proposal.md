## Why

Documentar retroativamente a capability de gerenciamento de sessões para que mudanças futuras no ciclo de vida de conversas tenham um contrato escrito. O comportamento já cruza tipos compartilhados, persistência, RPC, streaming e transferência, então a ausência de spec aumenta o risco de regressões em criação, histórico, branch/rollback, labels, status e anexos.

## What Changes

- Add new capability `session-management`.
- Formalizar o contrato de criação, persistência, streaming, branch/rollback, labels, status, cancelamento, anexos e transferência de sessões.
- Não altera comportamento de runtime nesta change; a mudança é documental e retroativa.

## Capabilities

### New Capabilities

- `session-management`: ciclo de vida de sessões, histórico persistido, eventos de streaming, branch/rollback, labels, status, anexos, cancelamento e transferência.

### Modified Capabilities

Nenhuma.

## Impact

- `packages/shared/src/sessions`: tipos, JSONL, storage, bundle/import-export e validações de sessão.
- `packages/core`: tipos base de sessão, mensagem, tool use/result, anexos e token usage.
- `packages/server-core/src/handlers/rpc/sessions.ts`: handlers RPC de CRUD, comandos, streaming, import/export e transferência remota.
- `packages/server-core/src/sessions/SessionManager`: orquestração de criação, persistência, backend ativo, streaming, branch, labels/status, cancelamento e import/export.
- `packages/server-core/src/handlers/rpc/transfer.ts`: transporte chunked para payloads grandes de importação.
