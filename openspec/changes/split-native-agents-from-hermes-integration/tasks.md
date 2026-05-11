## 1. Estrutura do Runtime Nativo

- [ ] 1.1 Criar módulo `packages/shared/src/agent/native/` ou similar.
- [ ] 1.2 Definir interface `NativeAgentRuntime` com `spawn(config)` como única API pública.
- [ ] 1.3 Implementar ponto de entrada público `spawnNativeAgent` para esconder factory, discovery de capability, escolha de driver e credential routing.

## 2. Migração dos Drivers Nativos

- [ ] 2.1 Mover drivers Anthropic e Pi do registry atual para o novo módulo nativo.
- [ ] 2.2 Preservar resolução de modelo session-scoped para Claude e Pi dentro do runtime nativo.
- [ ] 2.3 Preservar credential routing nativo para API key, OAuth Anthropic, OAuth Copilot e endpoints compatíveis.
- [ ] 2.4 Manter `computer-use` escopado ao Pi dentro do runtime nativo.

## 3. Consumers e Compatibilidade

- [ ] 3.1 Atualizar consumers em `server-core` para usar `spawnNativeAgent` quando o provider resolvido for nativo.
- [ ] 3.2 Atualizar consumers no Electron main para usar `spawnNativeAgent` quando o provider resolvido for nativo.
- [ ] 3.3 Marcar a factory atual de `agent-backends` como deprecated com comentário apontando para o novo módulo.
- [ ] 3.4 Garantir que providers Hermes continuem roteados para `hermes-embed`, fora do runtime nativo.

## 4. Hermes e Documentação

- [ ] 4.1 Atualizar `acp-config.ts` e `hermes-agent.ts` para reforçar que Hermes não passa pelo native runtime.
- [ ] 4.2 Atualizar docs (`AGENTS.md`, `hermes-embed.md`) refletindo a fronteira nova.

## 5. Testes e Validação

- [ ] 5.1 Atualizar testes substituindo testes de factory por contract tests do native runtime.
- [ ] 5.2 Adicionar cobertura garantindo que `hermes` não entra em `spawnNativeAgent`.
- [ ] 5.3 Rodar testes focados de agent backend, native runtime e Hermes embed.
- [ ] 5.4 Rodar `openspec validate split-native-agents-from-hermes-integration --strict --no-interactive`.
