## Context

Craft instancia agentes por uma camada comum em `packages/shared/src/agent/backend/factory.ts`. A factory resolve a conexão LLM da sessão, mapeia `providerType` para `AgentProvider`, monta runtime por driver interno e cria uma implementação concreta de `AgentBackend`.

Os backends atuais têm contratos diferentes:

- Claude usa `@anthropic-ai/claude-agent-sdk` em `packages/shared/src/agent/claude-agent.ts`, com opções de subprocesso em `packages/shared/src/agent/options.ts` e driver em `packages/shared/src/agent/backend/internal/drivers/anthropic.ts`.
- Pi usa SDKs `@mariozechner/pi-*` por um subprocesso JSONL gerenciado por `packages/shared/src/agent/pi-agent.ts` e implementado em `packages/pi-agent-server/src/index.ts`.
- Hermes usa um runtime Python/ACP separado em `packages/shared/src/agent/hermes-agent.ts`, configurado por `packages/shared/src/hermes/acp-config.ts` e detalhado pela capability `hermes-embed`.

AGENTS.md define que Hermes deve permanecer isolado dos outros agentes, com `HERMES_HOME` app-scoped, runtime Python vendorizado quando empacotado e ferramentas Craft passadas por ACP/session MCP, não por estado global compartilhado.

## Goals / Non-Goals

**Goals:**

- Descrever a seleção do backend pela config da sessão.
- Descrever autenticação e credenciais por backend sem expor segredos em logs.
- Preservar isolamento mútuo entre Claude, Pi e Hermes.
- Registrar o subprocesso Pi e a exclusividade de `computer-use`.
- Registrar que model selection é por sessão e preserva modelos customizados configurados para Hermes Messengers.

**Non-Goals:**

- Não alterar implementação existente.
- Não redefinir o contrato detalhado do runtime Hermes, que permanece na capability `hermes-embed`.
- Não introduzir novo provider ou nova credencial.
- Não mudar UX de settings.

## Decisions

### Factory

A factory deve produzir o backend correto com base no provider declarado pela configuração da sessão. O fluxo principal é:

- `resolveSessionConnection()` escolhe a conexão da sessão, default do workspace ou default global.
- `providerTypeToAgentProvider()` mapeia `anthropic` para Claude, `pi`/`pi_compat` para Pi e `hermes` para Hermes.
- `createBackendFromResolvedContext()` usa o driver interno para montar runtime provider-specific.
- `createBackend()` instancia `ClaudeAgent`, `PiAgent` ou `HermesAgent`.

Alternativa considerada: branching direto no renderer ou em handlers IPC. Foi evitado porque espalharia regras de provider, auth e runtime fora da camada de backend.

### Claude Backend

Claude deve usar o SDK oficial `@anthropic-ai/claude-agent-sdk`.

Arquivos relevantes:

- `packages/shared/src/agent/claude-agent.ts`
- `packages/shared/src/agent/options.ts`
- `packages/shared/src/agent/backend/claude/event-adapter.ts`
- `packages/shared/src/agent/backend/internal/drivers/anthropic.ts`
- `packages/shared/src/auth/claude-oauth.ts`
- `packages/shared/src/auth/claude-oauth-config.ts`
- `packages/shared/src/auth/state.ts`

O backend suporta Anthropic API key, Anthropic OAuth e endpoints custom compatíveis por variáveis de ambiente resolvidas a partir da conexão LLM. `postInit()` resolve credenciais por `packages/shared/src/auth`/credential manager, limpa variáveis Anthropic antigas e injeta o ambiente antes do subprocesso do SDK iniciar.

Alternativa considerada: reaproveitar a infraestrutura Pi para Anthropic. Foi evitado porque Claude tem SDK oficial e comportamento próprio de sessão, ferramentas e erros.

### Pi Backend

Pi deve usar os SDKs `@mariozechner/pi-*` em subprocesso. `PiAgent` no processo principal controla ciclo de vida, JSONL, eventos e proxy de ferramentas; `packages/pi-agent-server/src/index.ts` roda o SDK Pi, registry de modelos, auth storage in-memory, tools e session manager.

Arquivos relevantes:

- `packages/shared/src/agent/pi-agent.ts`
- `packages/shared/src/agent/backend/pi/*`
- `packages/shared/src/agent/backend/internal/drivers/pi.ts`
- `packages/pi-agent-server/src/index.ts`
- `packages/pi-agent-server/src/model-resolution.ts`
- `packages/pi-agent-server/src/custom-endpoint-models.ts`
- `packages/pi-agent-server/src/computer-use-tools.ts`

O backend Pi suporta Google AI Studio, ChatGPT Plus/Codex OAuth, GitHub Copilot OAuth, OpenAI API key e providers compatíveis via `piAuthProvider`, OAuth/API key/IAM/custom endpoint. Credenciais são buscadas no shared credential manager e passadas para o subprocesso no `init` ou por `token_update`; o auth storage Pi é in-memory.

`computer-use` é habilitado somente no Pi subprocess, apenas quando não headless e em macOS, adicionando o pacote `pi-computer-use` e seus nomes de ferramentas à allowlist Pi.

Alternativa considerada: carregar Pi SDK no processo principal. Foi evitado para isolar dependências ESM/pesadas e reduzir contaminação do runtime principal.

### Hermes Backend

Hermes deve ser um backend Python/ACP separado, não uma variação de Claude ou Pi. A configuração vem de `packages/shared/src/hermes/acp-config.ts`, e `HermesAgent` cria um provider ACP com comando, args, env, `HERMES_HOME`, MCP servers e sessão persistida.

Arquivos relevantes:

- `packages/shared/src/agent/hermes-agent.ts`
- `packages/shared/src/hermes/acp-config.ts`
- `packages/shared/src/hermes/auth-bridge.ts`
- `packages/shared/src/agent/backend/hermes/event-adapter.ts`
- `packages/shared/src/agent/backend/internal/drivers/hermes.ts`
- `packages/shared/src/mcp/session-tools-server.ts`

O contrato detalhado de bundling, overlays, runtime Python vendorizado e dashboard permanece em `hermes-embed`. Esta capability registra apenas que o backend Hermes é instanciado por ACP, usa `HERMES_HOME` app-scoped e não compartilha registry, fallback ou estado com Claude/Pi.

Alternativa considerada: tratar Hermes como provider compatível dentro de Pi ou Claude. Foi rejeitado pelo contrato de AGENTS.md: Hermes é runtime ACP/Python isolado.

### Isolamento Mútuo

Cada backend mantém seu próprio estado de sessão, modelo, ferramentas, fallback e autenticação transitória:

- Claude usa ambiente e SDK próprios.
- Pi usa subprocesso e `AuthStorage.inMemory()`.
- Hermes usa `HERMES_HOME` app-scoped/profile e MCP via ACP.

Credenciais persistidas ficam na camada compartilhada de auth/credentials e são injetadas no backend ativo apenas no momento necessário. Erros de auth devem virar erro discriminado ou aviso estruturado para que o renderer possa pedir re-login sem depender de exception bare.

## Risks / Trade-offs

- Contrato retroativo pode divergir se a implementação mudar sem atualizar OpenSpec -> mitigar exigindo atualização desta capability em mudanças futuras de backend/auth/runtime.
- Claude ainda usa variáveis de ambiente para o subprocesso SDK -> mitigar mantendo limpeza explícita de variáveis e `envOverrides` por sessão.
- Pi depende de subprocesso e protocolo JSONL -> mitigar com testes de lifecycle, stderr buffer e erro tipado.
- Hermes depende de runtime externo/vendorizado -> mitigar mantendo validação em `hermes-embed` e `HERMES_HOME` app-scoped.
