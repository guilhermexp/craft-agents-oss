## Context

`packages/session-tools-core/src/index.ts` reexporta o núcleo das session tools e `tool-defs.ts` já concentra nomes, descrições, schemas Zod de input e handlers. O `session-mcp-server` deriva a lista MCP a partir desse registro e converte inputs para JSON Schema, enquanto `HermesAgent` monta o endpoint `craft-session` em ACP `session.mcpServers` para o Hermes listar e chamar as mesmas tools com prefixo `mcp__session__*`.

O problema arquitetural é que isso ainda funciona como convenção de implementação, não como API de fronteira. Não há versão de contrato, schema de output obrigatório, nem teste de paridade que prove que o catálogo TypeScript consumido por agentes nativos é idêntico ao catálogo MCP/ACP que o Hermes recebe.

## Goals / Non-Goals

**Goals:**

- Definir uma API versionada para `session-tools-mcp`, começando por `v1`.
- Exigir schema explícito de input e output por tool.
- Usar uma fonte canônica para derivar tipos TypeScript, validação runtime e JSON Schema MCP.
- Validar em CI que o catálogo nativo e o catálogo ACP/MCP expõem os mesmos nomes, versões, descrições e schemas.
- Bloquear novas tools sem contrato declarado e teste de exposição.

**Non-Goals:**

- Implementar novas tools de sessão.
- Alterar a semântica de handlers existentes.
- Trocar o transporte ACP/MCP do Hermes.
- Remover compatibilidade com `mcp__session__*` enquanto Hermes consome `v1`.

## Decisions

### Schema canônico em Zod

Recomendação: manter Zod como tecnologia canônica de schema e aprofundar o registro atual para cobrir input e output.

Alternativas consideradas:

- Arquivos JSON Schema: bons para interoperabilidade direta, mas piores para inferência TypeScript e validação local dos handlers.
- TypeBox: bom para JSON Schema-first, mas adiciona uma segunda linguagem de schema à stack.
- Zod: já está na stack, já existe em `tool-defs.ts`, permite inferência TypeScript e validação runtime, e pode continuar gerando JSON Schema para MCP.

A decisão é criar um entry point único, por exemplo `defineTool(name, { version, inputSchema, outputSchema, handler, exposure })`, e derivar dele as views nativa, registry, backend e MCP. JSON Schema passa a ser output derivado, não a fonte primária.

### Contrato versionado

Toda tool exposta deve declarar uma versão de API. Tools existentes entram em `v1`; tools sem versão explícita durante a migração são tratadas como `v1` implícito apenas para compatibilidade temporária.

Mudanças incompatíveis em nome, input, output ou erro esperado exigem nova major (`v2`). Enquanto Hermes ACP só souber consumir `v1`, as tools `v1` permanecem disponíveis e deprecações devem ter janela explícita de migração.

### CI de paridade native e ACP/MCP

O CI deve executar um teste de contrato que:

- extrai o catálogo canônico do `session-tools-core`;
- inicializa um smoke do `session-mcp-server` ou mock ACP equivalente ao caminho usado por Hermes;
- lista as tools expostas pelo bridge;
- compara nomes, versões, descrições essenciais, input JSON Schema e output schema derivado;
- falha se uma tool existir em um lado e não no outro, ou se o schema divergir.

Esse teste substitui a confiança em testes ad hoc por tool para o contrato de exposição. Testes específicos de comportamento continuam existindo quando uma tool tem lógica própria relevante.

### Approval gate para tools novas

PRs que adicionarem ou expuserem tools novas devem passar por um check, como `lint:tool-contracts`, que valida:

- uso de `defineTool`;
- `inputSchema` e `outputSchema` explícitos;
- versão declarada;
- presença no catálogo canônico;
- exposição esperada no servidor MCP;
- cenário de contrato cobrindo o caminho native e o caminho ACP/MCP.

## Risks / Trade-offs

- Cerimônia maior para adicionar tools -> mitigada por `defineTool` pequeno, templates e mensagens de lint acionáveis.
- Divergência entre Zod e JSON Schema gerado -> mitigada por snapshots/contract tests do JSON Schema derivado e uso consistente do mesmo conversor.
- Migração gradual pode deixar tools sem output schema por um período -> mitigada por marcar compatibilidade temporária como `v1` implícito e fechar a migração antes de exigir o gate em modo obrigatório.
- Versionamento pode criar duplicação entre `v1` e `v2` -> mitigada por adapters finos e política de deprecação com remoção planejada.

## Migration Plan

1. Introduzir `defineTool` e metadados de versão sem mudar nomes públicos.
2. Migrar as tools existentes para o registro novo mantendo `v1` e compatibilidade com `mcp__session__*`.
3. Adicionar output schemas para todas as tools expostas.
4. Implementar o smoke de paridade native/ACP e rodar em CI.
5. Ativar o approval gate para novas tools depois que o catálogo existente estiver coberto.

Rollback: manter a geração MCP derivada do catálogo antigo até o gate estar obrigatório. Se o novo registro quebrar exposição, retornar temporariamente à view antiga enquanto os schemas são corrigidos.

## Open Questions

- Qual será a janela mínima de deprecação para remover uma tool `v1` depois que `v2` existir?
- O output schema deve modelar somente o `structuredContent` ou também o envelope textual de `ToolResult`?
- O smoke ACP deve usar o provider real com mock de Hermes ou apenas o servidor MCP isolado com o mesmo descriptor que `HermesAgent` monta?
