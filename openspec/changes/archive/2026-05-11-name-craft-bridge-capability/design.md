## Context

Achados concretos da investigação:

- `README.md:14-21` descreve Craft Agents como app de agentes da Craft, com fluxo mais centrado em documentos, e `README.md:108` anuncia "Craft MCP Integration" com ferramentas de documentos, blocos, coleções, busca e tarefas.
- `README.md:137-145` coloca Craft como exemplo de MCP server dentro de Sources, junto de Linear, GitHub, Notion, REST APIs e arquivos locais.
- `packages/shared/src/validation/url-validator.ts:24-44` valida especificamente URLs `https://mcp.craft.do/links/.../mcp`, então existe conhecimento de endpoint Craft no código.
- `packages/shared/src/auth/oauth.ts:9-11` usa `https://mcp.craft.do/my/mcp` como exemplo de MCP URL, e `packages/shared/src/auth/oauth.ts:961-964` cita Craft MCP como caso coberto pela descoberta OAuth RFC 9728.
- `packages/shared/src/sources/credential-manager.ts:604-643` autentica sources MCP OAuth via `CraftOAuth`, mas o fluxo é genérico para qualquer MCP OAuth e não tem módulo Craft próprio.
- `packages/shared/src/sources/builtin-sources.ts:8-19` diz que `craft-agents-docs` saiu de sources e virou MCP sempre disponível; `packages/shared/src/agent/claude-agent.ts:861-866` registra `craft-agents-docs` como MCP público de documentação do Craft Agents, não como documentos do usuário no produto Craft.
- `packages/shared/src/channels/types.ts:4-15` e `packages/shared/src/channels/types.ts:22-37` modelam canais por participantes, sources padrão e routing genérico; não há campo Craft específico.
- `openspec/specs/channels-war-room/spec.md:63-80` fala de inferência de lead Hermes, não de canal/produto Craft.
- `openspec/specs/meetings/spec.md:28-55` fala de Google OAuth, Google Drive/Workspace e sessão Craft da reunião; não há sync de documentos Craft materializado no diretório pedido `packages/shared/src/meetings/`, que nem existe no checkout atual.

Conclusão: Caso 1. Existe integração Craft material, mas ela é parcial e diluída. O que existe hoje é principalmente Craft MCP como source/endpoint OAuth e documentação sempre disponível; não encontrei sync de docs Craft para workspace files nem roteamento de mensagens Craft para sessions como módulo próprio.

## Goals / Non-Goals

**Goals:**

- Nomear `craft-bridge` como owner de integração com o produto Craft via MCP.
- Separar Craft MCP de sources genéricas sem quebrar sources MCP comuns.
- Declarar a fronteira entre documentação do Craft Agents e documentos do usuário no produto Craft.
- Preparar a extração de auth/validação/registro Craft para um módulo reconhecível.

**Non-Goals:**

- Implementar sync real de documentos Craft nesta change.
- Mover Google Meet, Google Drive, Slack, WhatsApp, GitHub ou Microsoft para `craft-bridge`.
- Reescrever channels ou transformar War Room em produto Craft.
- Tocar em código durante esta proposta.

## Decisions

1. Criar `craft-bridge` como capability real, mas com escopo inicial explícito.

   Racional: a evidência mostra Craft MCP real (`mcp.craft.do`) e promessa de ferramenta de documentos no README. Arquivar a change perderia a oportunidade de nomear um limite já existente.

   Alternativa considerada: arquivar por falta de sync de docs. Rejeitada porque auth/validação/source Craft já existem, mesmo sem módulo próprio.

2. Manter `workspace-and-sources` como capability genérica.

   Racional: sources suportam MCP, API e local para vários provedores. O bridge deve ser acionado quando a source for Craft MCP, não transformar sources em domínio Craft.

   Alternativa considerada: mover todo MCP OAuth para `craft-bridge`. Rejeitada porque `CraftOAuth` é nome histórico, mas o comportamento é genérico para qualquer MCP OAuth.

3. Manter `channels-war-room` genérico.

   Racional: canais têm participantes, mensagens, mentions e routing por agentes. Não há marcador Craft específico no modelo atual. O delta só cria contrato para quando contexto Craft for usado.

   Alternativa considerada: fazer canais pertencerem ao Craft Bridge. Rejeitada porque o War Room também cobre Hermes e agentes genéricos.

## Risks / Trade-offs

- Confundir `craft-agents-docs` com documentos Craft do usuário -> mitigar com nomenclatura explícita: docs do app ficam fora de `craft-bridge` salvo quando usados como documentação da integração.
- Criar capability larga demais -> mitigar limitando a auth Craft MCP, classificação/validação de endpoint, contexto/documentos Craft e roteamento explícito.
- Quebrar sources MCP genéricas ao extrair código -> mitigar mantendo OAuth MCP genérico no módulo comum e expondo só adaptadores Craft no bridge.
- Especificar sync antes de existir implementação -> mitigar declarando o sync como contrato do bridge quando implementado, com tasks separadas de inventário e extração.

## Migration Plan

1. Inventariar pontos Craft atuais e classificar cada um como documentação do app, source Craft MCP ou runtime Craft Agents.
2. Criar módulo `craft-bridge` sem alterar comportamento.
3. Mover validação/classificação de URL Craft MCP para o bridge.
4. Conectar sources Craft MCP ao bridge por adaptação explícita.
5. Adicionar sync/roteamento somente depois de contrato e testes de dados reais.

## Open Questions

- O produto Craft expõe sync bidirecional de documentos além do MCP `mcp.craft.do/links/.../mcp`?
- A integração deve suportar múltiplas contas/workspaces Craft por workspace local?
- "Sessões Craft" significa sessão do Craft Agents ou sessão/documento do produto Craft?
