## Context

O código atual concentra Claude, Pi e Hermes em `packages/shared/src/agent/backend/factory.ts` por meio de um `DRIVER_REGISTRY` comum. Isso facilita dispatch por `providerType`, mas esconde a diferença de produto: Claude e Pi são agentes nativos do monorepo que compartilham `SessionManager`, tools e credential routing; Hermes é um sistema externo embedded, inicializado por ACP/MCP, com runtime Python, dashboard e `HERMES_HOME` isolados.

Restrições:

- Hermes precisa continuar funcionando durante a migração e não pode passar a depender do runtime nativo.
- Pi pode ser deprecado futuramente, mas a spec atual ainda precisa preservar o contrato existente de subprocess e computer-use.
- O refactor atravessa `packages/shared`, consumers em `server-core` e Electron main; a proposta não altera runtime agora.
- `agent-backends` deve continuar útil como fronteira conceitual enquanto os detalhes migram para specs especializadas.

## Goals / Non-Goals

**Goals:**

- Criar uma fronteira explícita para agentes nativos do monorepo: Claude SDK e Pi subprocess.
- Esconder discovery de capability, escolha de driver, resolução de modelo e credential routing atrás de uma única API pública, por exemplo `spawnNativeAgent(connectionConfig)`.
- Manter Hermes documentado e validado por `hermes-embed`, sem linguagem que o trate como peer da factory nativa.
- Reduzir a superfície onde bug em configuração Pi/Claude pode afetar boot, dashboard ou config Hermes.

**Non-Goals:**

- Implementar o refactor nesta change.
- Remover Hermes, Pi ou Claude.
- Criar a capability completa `hermes-integration`; esta proposta apenas referencia que esse detalhamento pode existir em outra change.
- Alterar o comportamento de sessão, MCP ou auth em runtime.

## Decisions

### Separar `native-agent-runtime` como dono de Claude e Pi

O novo módulo deve conter factory, driver pool e model registry apenas para provedores nativos. A API pública deve ser estreita, como `spawnNativeAgent(connectionConfig)`, retornando um `NativeAgentRuntime` com `spawn(config)` como operação principal.

Alternativa considerada: manter `factory.ts` como registry único e adicionar comentários. Isso não resolve o acoplamento real, porque qualquer feature de driver continuaria enxergando Hermes como uma opção equivalente.

### Manter `agent-backends` como fronteira conceitual

`agent-backends` deve responder "qual família de runtime esta sessão usa?", não "como cada driver é construído?". Os detalhes de Claude/Pi migram para `native-agent-runtime`; os detalhes de Hermes permanecem em `hermes-embed`.

Alternativa considerada: remover `agent-backends`. Isso criaria um salto grande demais para consumers existentes e perderia o contrato de isolamento entre famílias durante a migração.

### Deixar Hermes fora do ponto de entrada nativo

Hermes deve continuar usando `HermesAgent`, `acp-config.ts`, auth bridge e `session.mcpServers` próprios. O caminho nativo não deve importar drivers Hermes, normalizar runtime Hermes, resolver dashboard URL nem tocar `HERMES_HOME`.

Alternativa considerada: criar um adapter Hermes fino dentro do runtime nativo. Isso preservaria a confusão atual com outro nome.

### Trocar testes de factory por contract tests do runtime nativo

Os testes devem validar o contrato de `spawnNativeAgent`: Anthropic escolhe Claude SDK, Pi escolhe subprocess Pi, credenciais corretas são roteadas, modelos são resolvidos por sessão e Hermes é rejeitado ou roteado para a integração externa antes de entrar no runtime nativo.

Alternativa considerada: continuar testando cada driver isolado por meio da factory antiga. Isso mantém cobertura de detalhes, mas não protege o boundary arquitetural.

## Risks / Trade-offs

- Refactor cross-pacote pode quebrar consumers que dependem de helpers legados → manter compat layer deprecated em `agent-backends` até todos os callers migrarem.
- Pode haver duplicação transitória entre factory antiga e `native-agent-runtime` → limitar a duplicação ao período de migração e centralizar novos testes no contrato novo.
- Separar Hermes reduz conveniência de dispatch genérico → compensar com um boundary explícito em `agent-backends` que classifica runtime nativo versus integração externa.
- Pi pode ser removido futuramente → manter o spec nativo focado no contrato atual, sem transformar deprecação em requisito desta change.

## Migration Plan

1. Criar `packages/shared/src/agent/native/` com `spawnNativeAgent` e interface `NativeAgentRuntime`.
2. Mover os drivers Anthropic e Pi para o novo módulo, preservando a compatibilidade da factory antiga.
3. Atualizar consumers para chamar `spawnNativeAgent` quando o provider resolvido for nativo.
4. Marcar a factory antiga como deprecated e manter Hermes no caminho `hermes-embed`.
5. Substituir testes centrados no registry misto por contract tests de runtime nativo e testes de isolamento Hermes.

## Open Questions

- O nome público final deve ser `spawnNativeAgent`, `createNativeAgent` ou outro padrão já usado no repo?
- O boundary `agent-backends` deve rejeitar Hermes antes do runtime nativo ou apenas encaminhar explicitamente para `hermes-embed`?
- A futura capability `hermes-integration` deve cobrir canais/sources Craft ou apenas a ponte ACP/MCP de sessão?
