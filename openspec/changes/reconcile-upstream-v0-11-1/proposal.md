## Why

O merge conservador do Craft upstream `v0.11.1` preservou o overlay local do
fork, mas deixou contratos TypeScript incompatíveis entre arquivos novos do
upstream e implementações locais anteriores. A árvore precisa ser reconciliada
semanticamente antes de ser considerada integrável, sem remover Hermes,
credential storage, browser/RTK ou outras customizações do fork.

## What Changes

- Reconciliar APIs internas novas do upstream com os contratos preservados do
  fork nos runtimes Claude/Pi, session tools, configuração, storage e RPC.
- Preservar o isolamento do Hermes e as proteções locais de credenciais/browser.
- Restaurar os gates canônicos `validate:ci` e `electron:build`.
- Corrigir regressões de concorrência, retry, acessibilidade e tratamento de
  erros identificadas no review pré-push do renderer Electron.
- Não alterar contratos públicos do session-tools MCP nem formatos persistidos.

## Capabilities

### Modified Capabilities

- `agent-backends`: compatibiliza os adapters Claude/Pi e resolução de modelos
  após o merge, mantendo Hermes fora do runtime nativo.
- `native-agent-runtime`: preserva capability discovery, credential routing e
  computer-use do Pi sob as APIs introduzidas pelo upstream.
- `session-tools-mcp`: preserva validação canônica e contratos v1 ao reconciliar
  implementações e testes trazidos pelo upstream.

## Impact

- `packages/session-tools-core`
- `packages/shared/src/agent`, `packages/shared/src/config`, `packages/shared/src/storage`
- `packages/pi-agent-server`
- `packages/server-core`, `packages/server`
- `apps/electron`
