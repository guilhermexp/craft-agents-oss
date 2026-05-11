## Why

`packages/shared/src/agent/options.ts` hoje executa higiene de `~/.claude.json` dentro de uma utilidade de opções do SDK Anthropic. A função `ensureClaudeConfig()` remove arquivos `.backup` e `.corrupted.*`, regrava JSON vazio/corrompido, remove BOM UTF-8 e usa uma flag global `claudeConfigChecked` para bloquear rechecks subsequentes. Isso cria side-effects de filesystem escondidos no caminho de inicialização do SDK, com timing implícito e sem contrato claro para os callers.

Essa responsabilidade precisa sair da montagem de opções do subprocesso. A validade da configuração Claude deve ser uma decisão explícita de startup, antes de qualquer driver ser instanciado.

## What Changes

- Extrair um `ClaudeConfigManager` dedicado para validação, migração, recuperação de corrupção e higiene de encoding do `~/.claude.json`.
- Chamar `ClaudeConfigManager.ensureValid()` uma vez no startup do Craft, antes de instanciar drivers/backends.
- Tornar a inicialização do SDK Anthropic pura: `getDefaultOptions()` deve montar opções/env do subprocesso sem tocar no filesystem de configuração Claude.
- Expor `getValidatedConfig()` para callers que precisem consumir a configuração já saneada ou receber um erro tipado.
- Remover a lógica de cleanup silencioso de `options.ts` e substituir call sites por uso explícito do manager.

## Capabilities

### New Capabilities

Nenhuma.

### Modified Capabilities

- `agent-backends`: declara que a higiene de configuração Claude é responsabilidade única de startup, antes da criação de drivers, e não side-effect da montagem de opções do SDK.

## Impact

- `packages/shared/src/agent/options.ts`
- `packages/shared/src/agent/backend/factory.ts`
- `packages/shared/src/agent/backend/internal/drivers/anthropic.ts`
- Novo manager em `packages/shared/src/agent/native/claude-config-manager.ts` ou path equivalente conforme a organização final do módulo.
- Tests isolados para validação, migração, recuperação de corrupção e remoção de BOM.
