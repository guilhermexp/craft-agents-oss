## Why

Hermes é um sistema vizinho integrado ao Craft por ACP/MCP, com runtime Python, dashboard e `HERMES_HOME` próprios; ele não deve ser tratado como peer nativo de Claude e Pi. Hoje o registry estático em `packages/shared/src/agent/backend/factory.ts` coloca `anthropic`, `hermes` e `pi` no mesmo pool de drivers, borrando a fronteira de produto e permitindo que mudanças em configuração nativa viagem pelo caminho de boot do Hermes.

## What Changes

- Criar a capability `native-agent-runtime` para possuir somente Claude SDK e Pi subprocess: factory nativa, registry nativo, resolução de modelo e roteamento de credenciais desses dois runtimes.
- Reescopar `agent-backends` para ficar como fronteira conceitual entre famílias de agentes, sem detalhar a implementação interna de Claude/Pi nem do Hermes embedded.
- Clarificar `hermes-embed` para declarar Hermes como sistema externo embedded, não peer nativo da factory Claude/Pi.
- Sem **BREAKING**: os contratos documentam a direção arquitetural e permitem migração gradual do código existente.

## Capabilities

### New Capabilities

- `native-agent-runtime`: runtime nativo de agentes do monorepo, cobrindo Claude via SDK Anthropic, Pi via `pi-agent-server`, factory nativa, discovery de capability, resolução de modelo e credential routing sem incluir Hermes.

### Modified Capabilities

- `agent-backends`: passa a descrever apenas a fronteira conceitual entre runtimes nativos e integrações externas, removendo detalhes de factory/driver/modelos que migram para `native-agent-runtime` e `hermes-embed`.
- `hermes-embed`: explicita que Hermes é sistema externo embedded via ACP/MCP, isolado da factory nativa Claude/Pi e configurado por seus próprios contratos de runtime.

## Impact

- `packages/shared/src/agent/backend/*`: refactor futuro para retirar Claude/Pi do registry misto e deprecar a factory atual como compat layer.
- `packages/shared/src/agent/native/` ou módulo equivalente: novo ponto de entrada público do runtime nativo.
- Consumers do factory em `packages/server-core` e Electron main: migração futura para `spawnNativeAgent`.
- `packages/shared/src/hermes/acp-config.ts` e `packages/shared/src/agent/hermes-agent.ts`: reforço documental e de wiring para manter Hermes fora do runtime nativo.
