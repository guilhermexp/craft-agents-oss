## 1. Contract Model

- [ ] 1.1 Escolher a tecnologia de schema e confirmar Zod como fonte canônica recomendada pela stack do projeto
- [ ] 1.2 Definir a API de registro `defineTool(name, { version, inputSchema, outputSchema, handler })` como entry point único
- [ ] 1.3 Definir a política de versionamento `v1`/`v2`, incluindo deprecação e compatibilidade do prefixo Hermes `mcp__session__*`

## 2. Migration

- [ ] 2.1 Criar namespace `v1/` para o contrato público das session tools, mantendo tools sem versão como `v1` implícito durante a migração
- [ ] 2.2 Migrar as tools existentes para usar `defineTool`
- [ ] 2.3 Declarar output schemas explícitos para todas as tools expostas
- [ ] 2.4 Atualizar o empacotamento MCP para derivar o catálogo apenas do registro versionado

## 3. Validation

- [ ] 3.1 Criar script de CI, como `lint:tool-contracts`, para extrair schemas canônicos e validar completude do registro
- [ ] 3.2 Adicionar smoke ACP/MCP que lista as tools expostas pelo bridge usado por Hermes
- [ ] 3.3 Comparar em CI o catálogo native com o catálogo ACP/MCP, incluindo nome, versão, input schema e output schema
- [ ] 3.4 Cobrir o gate de PR para bloquear tools novas sem schema explícito, versão e teste de contrato

## 4. Documentation

- [ ] 4.1 Atualizar a spec `session-tools-mcp` com o contrato de API versionada
- [ ] 4.2 Atualizar `AGENTS.md` com o procedimento para alterar session tools de fronteira
