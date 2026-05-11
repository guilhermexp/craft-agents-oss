## Context

O backend Claude usa o SDK oficial `@anthropic-ai/claude-agent-sdk`. Antes do subprocesso do SDK iniciar, o código atual chama `ensureClaudeConfig()` a partir de `getDefaultOptions()` em `packages/shared/src/agent/options.ts`.

Essa função não apenas calcula opções. Ela altera o filesystem do usuário:

- remove `~/.claude.json.backup`;
- remove arquivos `~/.claude.json.corrupted.*`;
- cria `~/.claude.json` quando ausente;
- substitui arquivo vazio ou JSON inválido por `{}`;
- remove BOM UTF-8 preservando JSON válido;
- bloqueia execuções futuras por `claudeConfigChecked`.

O problema não é a higiene em si. O problema é o acoplamento: uma função usada para iniciar o SDK tem efeitos de reparo de configuração, roda silenciosamente e depende de uma flag global que pode impedir revalidação depois de mudanças no arquivo.

## Goals / Non-Goals

**Goals:**

- Centralizar validação, migração, recuperação e higiene de encoding em `ClaudeConfigManager`.
- Tornar explícito quando Craft toca em `~/.claude.json`.
- Executar `ensureValid()` uma vez no startup, antes de criar drivers/backends.
- Manter `getDefaultOptions()` sem side-effects de configuração Claude.
- Cobrir os cenários existentes com tests isolados.

**Non-Goals:**

- Não alterar o formato público do `~/.claude.json` além das migrações necessárias.
- Não mudar autenticação, OAuth ou seleção de modelo do backend Claude.
- Não reutilizar essa lógica para Pi ou Hermes.
- Não mover estado Claude para `HERMES_HOME` ou outro home app-scoped.

## Proposed Structure

Criar um módulo dedicado:

```text
packages/shared/src/agent/native/claude-config-manager.ts
```

Se a organização final de `native/` não for adequada no momento da implementação, usar um path equivalente sob `packages/shared/src/agent/` que mantenha a responsabilidade fora de `options.ts` e fora do driver Anthropic.

API proposta:

```ts
export type ClaudeConfigValidationError =
  | { type: 'claude_config_unreadable'; path: string; cause: unknown }
  | { type: 'claude_config_unwritable'; path: string; cause: unknown }
  | { type: 'claude_config_invalid_after_recovery'; path: string; cause: unknown };

export interface ClaudeConfigManager {
  ensureValid(): Promise<void>;
  getValidatedConfig(): Promise<Record<string, unknown>>;
}
```

`ensureValid()` deve ser chamado no startup do Craft, antes de `initializeBackendHostRuntime()` ou antes de qualquer fluxo que possa instanciar o backend Claude. A chamada deve ser explícita no bootstrap, não acionada por `getDefaultOptions()`.

`getValidatedConfig()` deve retornar a config saudável já parseada ou falhar com erro tipado. Ela não deve mascarar erro crítico depois que a recuperação falhar.

## Migration

1. Mover de `options.ts` para o manager a lógica de:
   - remoção de `.backup`;
   - remoção de `.corrupted.*`;
   - criação de `{}` quando ausente;
   - reset de arquivo vazio;
   - reset de JSON inválido;
   - strip de BOM UTF-8;
   - escrita com retry para Windows quando aplicável.
2. Remover `ensureClaudeConfig()` de `getDefaultOptions()`.
3. Remover ou substituir `resetClaudeConfigCheck()` por uma operação explícita do manager, caso ainda seja necessária para retry depois de erro detectado em runtime.
4. Adicionar a chamada de startup para `ClaudeConfigManager.ensureValid()`.
5. Manter a inicialização do SDK Anthropic restrita a montagem de `Options`, env, executable, interceptor e path do CLI.

## Tests

Adicionar tests isolados para o manager usando filesystem temporário, cobrindo:

- config ausente cria `{}`;
- `.backup` stale é removido;
- `.corrupted.*` stale é removido;
- arquivo vazio vira `{}`;
- arquivo BOM-only vira `{}`;
- JSON válido com BOM é reescrito sem BOM e preserva dados;
- JSON inválido é recuperado para `{}`;
- falha de escrita retorna erro tipado;
- `getValidatedConfig()` retorna objeto parseado para config saudável.

Adicionar test de integração leve garantindo que `getDefaultOptions()` não toca em `~/.claude.json`.

## Trade-offs

Reposicionar a chamada exige identificar o ponto correto de startup e manter a ordem antes da primeira instanciação de driver Claude. O ganho é eliminar surpresa: reparos de filesystem deixam de ocorrer dentro de uma util de opções e passam a ter contrato operacional claro, testável e observável.
