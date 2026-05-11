## Context

O Craft organiza sessões, sources, skills e configurações por workspace. Um workspace pode apontar para uma pasta local do usuário ou para um servidor remoto, preservando um registro local que contém dados de conexão do servidor remoto. Sources são conexões externas escopadas ao workspace e podem expor ferramentas MCP, APIs convertidas para ferramentas ou acesso a filesystem.

Esta change é uma documentação retroativa: o objetivo é capturar o contrato arquitetural já esperado para workspaces e sources, sem alterar código.

## Goals / Non-Goals

**Goals:**

- Documentar workspaces locais e remotos como a unidade de escopo principal.
- Documentar sources MCP, API e filesystem como tipos discriminados.
- Definir que OAuth é resolvido por provider e que tokens ficam em store seguro.
- Definir validação obrigatória de conexão antes de persistir novas sources.
- Definir que filesystem source não pode escapar do boundary do workspace.
- Documentar que a UI de workspace picker lista workspaces existentes e permite criar/conectar novos.

**Non-Goals:**

- Não alterar o runtime Hermes, ACP ou session tools.
- Não migrar configurações existentes.
- Não mudar nomes de canais RPC existentes.
- Não redesenhar a UI.

## Decisions

### Workspaces locais e remotos usam o mesmo modelo de produto

Workspaces continuam sendo a abstração de pasta de trabalho com configuração própria. Para workspaces locais, a raiz é uma pasta no filesystem do usuário. Para workspaces remotos, a entrada local mantém `remoteServer` com URL, token e workspace remoto, e o cliente usa `CRAFT_SERVER_URL` e `CRAFT_SERVER_TOKEN` para conectar ao servidor.

Alternativa considerada: separar workspace local e remoto em entidades de produto diferentes. Isso duplicaria fluxos de sessão, sources e configurações, então o contrato mantém uma abstração única.

### Sources usam tipo discriminado

Cada source deve declarar exatamente um tipo: `mcp`, `api` ou `filesystem`. Sources MCP representam servidores externos ou subprocessos stdio; sources API representam endpoints REST/GraphQL acessados via ferramenta dinâmica; sources filesystem representam pastas/arquivos escopados ao workspace.

Alternativa considerada: inferir o tipo pela presença de blocos de configuração. Isso torna validação e UI mais frágeis, então o tipo discriminado é o contrato.

### OAuth fica separado da configuração do workspace/source

Configuração pode conter metadados não secretos, como provider, escopos e client IDs públicos. Tokens OAuth, API keys, bearer tokens e credenciais equivalentes ficam em store seguro, indexados por workspace/source/provider, e não em `config.json` do workspace.

Alternativa considerada: persistir tokens junto do source para simplificar portabilidade. Isso aumenta risco de vazamento e mistura segredo com configuração versionável, então fica fora do contrato.

### Criar source exige validação de conexão antes de persistir

O fluxo de criação deve executar o `test` da source antes de persisti-la como disponível. Para MCP, o teste valida transporte, autenticação e listagem/esquema de ferramentas. Para API, o teste usa `testEndpoint` quando configurado. Para filesystem, o teste valida existência, permissões e boundary do workspace.

Alternativa considerada: permitir persistir sources em estado `untested`. Como esta capability será base para automações e agentes, a criação nova deve falhar cedo quando a conexão não é válida.

### MCP stdio é subprocesso gerenciado por sessão

Sources MCP com transporte stdio são spawned como subprocessos gerenciados pela sessão/pool MCP, respeitando a configuração de local MCP do workspace. Isso evita processos globais invisíveis e mantém o ciclo de vida alinhado à sessão ativa.

Alternativa considerada: iniciar MCP stdio como daemon global por app. Isso dificulta isolamento por workspace e limpeza de sessão.

## Risks / Trade-offs

- [Risk] Servidores remotos antigos podem não expor todos os metadados esperados pela UI. → Mitigar mantendo fallback de conexão e mensagens explícitas de incompatibilidade.
- [Risk] Providers OAuth têm variações de escopo e refresh token. → Mitigar com fluxo por provider e refresh centralizado no credential manager.
- [Risk] MCP stdio pode executar comandos locais de alto impacto. → Mitigar com gate de local MCP por workspace e lifecycle por sessão.
- [Risk] Paths de filesystem podem tentar traversal com `..` ou symlink. → Mitigar com resolução/canonicalização antes de permitir leitura/escrita.

## Migration Plan

Como a change é retroativa, não há migração de dados. Ao arquivar a spec, futuras mudanças devem comparar novos requisitos com `workspace-and-sources` antes de alterar tipos, RPC handlers, UI de workspace ou source validation.

Rollback consiste em remover esta change antes de arquivar, sem impacto em runtime.

## Open Questions

- O contrato público deve manter o nome `filesystem` enquanto o código atual usa bloco `local`, ou a próxima mudança deve formalizar um alias compatível?
- O fluxo de criação deve permitir salvar rascunhos inválidos em UI avançada, desde que não fiquem habilitados para sessões?
