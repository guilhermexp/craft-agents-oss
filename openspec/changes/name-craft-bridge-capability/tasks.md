## 1. Inventário e Fronteira

- [ ] 1.1 Classificar todas as referências Craft atuais como branding/runtime Craft Agents, documentação `craft-agents-docs`, ou produto Craft via `mcp.craft.do`.
- [ ] 1.2 Definir o contrato público do módulo `craft-bridge` para detectar source Craft MCP sem alterar sources genéricas.
- [ ] 1.3 Documentar a distinção entre Craft Agents Docs e documentos do usuário no produto Craft.

## 2. Extração de Bridge

- [ ] 2.1 Criar estrutura de módulo `craft-bridge` para classificação de endpoint, auth adapter e contexto Craft.
- [ ] 2.2 Mover a validação específica de URL `mcp.craft.do/links/.../mcp` para `craft-bridge`.
- [ ] 2.3 Adaptar o fluxo de source MCP OAuth para delegar casos Craft ao bridge mantendo OAuth MCP genérico fora dele.
- [ ] 2.4 Garantir que `craft-agents-docs` permaneça como documentação pública do app e não vire source de documentos do usuário.

## 3. Contexto e Roteamento

- [ ] 3.1 Definir como documentos/contexto Craft entram em workspace files quando houver source Craft autenticada.
- [ ] 3.2 Adicionar contrato explícito para channels consumirem contexto Craft somente via `craft-bridge`.
- [ ] 3.3 Cobrir a extração com testes de source Craft MCP, source MCP genérica, auth OAuth genérico e canal sem contexto Craft.
