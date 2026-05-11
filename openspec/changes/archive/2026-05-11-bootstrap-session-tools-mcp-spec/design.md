## Context

`session-tools-mcp` documenta ferramentas Craft-native que agentes recebem em runtime como MCP session-scoped. A fonte canonica das definicoes fica em `packages/session-tools-core`, onde TypeScript puro define schemas Zod, descricoes, modo de execucao, safe-mode e handlers compartilhados.

Existem dois pontos de empacotamento MCP:

- `packages/session-mcp-server` empacota as tools como servidor MCP CJS/stdio para runtimes que precisam de processo separado.
- `packages/shared/src/mcp/session-tools-server.ts` cria um servidor MCP HTTP local, por sessao, usado pelo `HermesAgent` via ACP `session.mcpServers` com o nome `craft-session`.

O `HermesAgent` inicia o servidor da sessao, passa sua URL para `buildHermesAcpMcpServers`, e o ACP expõe as tools para Hermes preservando o prefixo de consumidor `mcp__session__<tool>`.

## Goals / Non-Goals

**Goals:**

- Registrar a arquitetura atual de tools MCP session-scoped.
- Listar as tools expostas e seus escopos.
- Preservar o contrato de isolamento por `workspaceId` e `sessionId`.
- Preservar o contrato Hermes/ACP e os nomes Craft-native.
- Documentar requisitos de seguranca para source validation, memory, pure transforms/rendering, Mermaid e script sandbox.

**Non-Goals:**

- Redesenhar o registry de tools.
- Alterar formato de storage de sessoes, sources, memoria ou preferencias.
- Mudar o runtime Hermes ou substituir ACP.
- Tornar tools globais por `mcp.json` estatico.

## Decisions

### Tools em TypeScript puro no core

As definicoes ficam em `packages/session-tools-core` para que Claude, Pi, Codex e MCP reusem os mesmos schemas e handlers. O registry canonico `SESSION_TOOL_DEFS` evita divergencia de nomes, descricoes e safe-mode entre backends.

Alternativa considerada: cada backend definir suas proprias tools. Isso duplicaria contratos e aumentaria risco de paridade quebrada.

### Servidor MCP por sessao

O servidor MCP recebe contexto injetado da sessao ativa, incluindo `sessionId`, caminhos de workspace/sessao e callbacks disponiveis. Tools nao devem depender de estado global para decidir qual sessao operar.

Alternativa considerada: servidor MCP global compartilhado. Isso facilitaria bootstrap, mas criaria risco de vazamento entre sessoes e exigiria autorizacao manual por argumento em cada tool.

### Hermes consome por ACP `session.mcpServers`

Hermes recebe o servidor `craft-session` na criacao/retomada da sessao ACP, junto com sources MCP ativas. O nome externo de consumidor deve continuar `mcp__session__<tool>`, preservando compatibilidade com os patches de naming do Hermes.

Alternativa considerada: escrever as tools Craft em um `mcp.json` Hermes estatico. Isso quebraria o escopo de sessao e tornaria browser, delegacao, callbacks e auth globais.

### Erros como tool result

Handlers devem retornar `ToolResult` com `isError` e texto prefixado por `[ERROR]` quando houver falha, em vez de deixar exception crua escapar. O servidor MCP tambem captura falhas inesperadas e converte em resposta de erro.

Alternativa considerada: deixar exceptions subirem para o cliente MCP. Isso dificulta recuperacao pelo agente e perde contexto estruturado.

## Tool Surface

Tools canonicas de `packages/session-tools-core`:

- `SubmitPlan`: submete um plano escrito em arquivo para revisao do usuario e pausa a execucao.
- `config_validate`: valida config, sources, statuses, preferences, permissions, automations, tool-icons ou tudo.
- `skill_validate`: valida `SKILL.md` de uma skill do workspace.
- `mermaid_validate`: valida sintaxe Mermaid antes de retornar o diagrama.
- `source_test`: valida schema, completude, icone, conexao, auth e opcionalmente ativa a source na sessao.
- `source_oauth_trigger`: inicia OAuth MCP padrao para uma source.
- `source_google_oauth_trigger`: inicia OAuth Google para sources Google.
- `source_slack_oauth_trigger`: inicia OAuth Slack.
- `source_microsoft_oauth_trigger`: inicia OAuth Microsoft.
- `source_credential_prompt`: solicita credenciais nao OAuth ao usuario.
- `update_user_preferences`: atualiza preferencias confirmadas do usuario.
- `transform_data`: transforma arquivos da sessao ou assets de skill e grava output em `data/`.
- `script_sandbox`: executa diagnosticos curtos em subprocesso com isolamento obrigatorio de rede e filesystem.
- `render_template`: renderiza template HTML de uma source com dados fornecidos.
- `send_developer_feedback`: registra feedback markdown para o time de desenvolvimento.
- `call_llm`: chama um LLM secundario via callback/backend.
- `spawn_session`: cria sessao independente para delegacao.
- `browser_tool`: executa comandos de browser por runtime backend-specific.
- `set_session_labels`: atualiza labels da sessao atual ou de sessao permitida pelo callback.
- `set_session_status`: atualiza status da sessao atual ou de sessao permitida pelo callback.
- `get_session_info`: le metadata da sessao atual ou de sessao permitida pelo callback.
- `list_sessions`: lista sessoes do workspace com filtros e paginacao.
- `memory_store`: grava memoria persistente quando a feature esta habilitada.
- `memory_recall`: busca memoria persistente quando a feature esta habilitada.
- `send_agent_message`: envia mensagem para outra sessao.
- `list_messaging_channels`: lista canais Telegram/WhatsApp vinculados a uma sessao.
- `unbind_messaging_channel`: desvincula canais de messaging da sessao atual.

Tools adicionadas pelo bridge Hermes em `packages/shared/src/mcp/session-tools-server.ts`:

- `automation_tool`: lista, cria, alterna, remove e le historico de automacoes Craft-native do workspace.
- `meeting_tool`: inicia, consulta, lista, le transcript ou para meeting capture quando callbacks nativos estao disponiveis.

## Isolation

Cada instancia de servidor recebe contexto da sessao. O contexto contem `workspaceId`, `workspaceRootPath`, `sessionId`, caminhos de `sessions/<sessionId>`, `data/`, `sources/`, `skills/` e callbacks registrados para aquela sessao.

Nenhuma tool deve operar fora de sessao. Quando uma tool aceita `sessionId` opcional para leitura ou coordenacao, a resolucao e autorizacao devem passar pelos callbacks session-scoped registrados pelo backend, nao por acesso global arbitrario.

O sandbox de script deve:

- resolver input relativo ao diretorio da sessao;
- bloquear escape por `..` e por symlink com checagem lexical e realpath;
- restringir escrita ao diretorio da sessao;
- remover variaveis sensiveis do ambiente;
- exigir isolamento de rede em todos os modos de permissao;
- falhar fechado quando o backend de isolamento nao esta disponivel.

## Risks / Trade-offs

- Risco: divergencia entre o registry canonico e bridges MCP extras. Mitigacao: bridges devem derivar `getToolDefsAsJsonSchema()` e adicionar apenas tools nativas inevitaveis, como automations/meetings.
- Risco: Hermes nao atualizar tools apos mudanca de sources. Mitigacao: `HermesAgent` reinicia o provider quando descriptors MCP mudam.
- Risco: argumentos `sessionId` em tools de gerenciamento podem ser usados fora do escopo pretendido. Mitigacao: callbacks session-scoped do backend controlam a resolucao e devem restringir ao workspace/sessao permitidos.
- Risco: runtimes sem isolamento suportado tentarem executar sandbox. Mitigacao: `script_sandbox` falha fechado quando network ou filesystem isolation nao sao `enforced`.

## Migration Plan

Esta change e retroativa. Nao requer migracao de dados.

Para mudancas futuras:

1. Atualizar `packages/session-tools-core` e os bridges MCP mantendo o registry canonico como source of truth.
2. Atualizar este spec quando adicionar/remover tool ou alterar requisitos de isolamento.
3. Validar os testes focados de session tools e Hermes quando a integracao ACP/MCP mudar.

## Open Questions

Nenhuma no bootstrap retroativo.
