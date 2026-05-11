## 1. Implementação

- [x] 1.1 Criar `ClaudeConfigManager` em path apropriado sob `packages/shared/src/agent/`
- [x] 1.2 Mover lógica de unlink de `.backup` e `.corrupted.*` para o manager
- [x] 1.3 Mover lógica de BOM strip, arquivo ausente, arquivo vazio e JSON inválido para o manager
- [x] 1.4 Definir `ensureValid()` e `getValidatedConfig()` com erros tipados
- [x] 1.5 Substituir chamadas a `ensureClaudeConfig` por uso explícito do manager no startup
- [x] 1.6 Remover side-effects de config Claude de `getDefaultOptions()`
- [x] 1.7 Atualizar ou remover `resetClaudeConfigCheck()` conforme o novo fluxo de retry
- [x] 1.8 Adicionar tests cobrindo cada cenário de corrupção e recuperação
- [x] 1.9 Adicionar test garantindo que a montagem de opções do SDK Anthropic é pura
- [x] 1.10 Atualizar spec `agent-backends` ou `native-agent-runtime` conforme a ordem das changes
