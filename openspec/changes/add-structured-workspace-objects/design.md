# Design — structured workspace objects

## Context

O requisito de produto é um único contrato de objetos que possa ser modificado
por agentes e pelo Desktop, com atualização reativa da UI. O plano de origem é
`docs/plans/2026-08-01-001-feat-structured-workspace-objects-plan.md` e mantém os
IDs U1-U9 usados nas tasks.

O repo já oferece quatro peças que devem ser compostas, não duplicadas:

- `packages/shared/src/memory/sqlite-driver.ts` seleciona SQLite por runtime;
- `packages/session-tools-core/src/tool-defs.ts` governa tools versionadas e Zod;
- `packages/server-core/src/sessions/SessionManager.ts` governa subscriptions;
- a sidebar em `AppShell.tsx` e `SessionFilesSection.tsx` já possui árvore,
  preview inline e fallback para viewers especializados.

## Domínio canônico

Cada workspace estruturado possui `objects/objects.sqlite`. O schema normaliza:

- objetos e revisões;
- definições de campo e opções;
- entries e valores tipados;
- relações por stable ID;
- saved views e settings;
- action history;
- read projections e estado da projeção em filesystem.

Os tipos iniciais são text, number, boolean, date, datetime, select, status,
relation e file. O tipo e suas constraints são dados versionados; novos tipos
não exigem uma tabela física por feature.

`object_payloads` mantém uma projeção denormalizada com a revisão fonte. Se o
payload não existir ou estiver stale, o repository o reconstrói das tabelas
normalizadas e regrava a projeção. Correção nunca depende da projeção existir.

## Protocolo SQLite ↔ filesystem

SQLite é a única autoridade. O runtime executa duas etapas recuperáveis:

1. valida a operação, abre transação, atualiza rows normalizadas, read projection
   e revisão, então faz commit;
2. escreve atomicamente `objects/<slug>/object.yaml`, relê e valida stable ID e
   revisão.

Depois da segunda etapa publica exatamente um evento pós-commit:

- `ready`: manifest válido;
- `projection-error`: canonical commit existe, manifest requer reparo.

Ambos os eventos invalidam o conteúdo para que o objeto canônico permaneça
visível. `projection-error` também apresenta estado acionável. Deletar um
manifest dispara reconstrução idempotente. Um manifest com stable ID divergente
é conflito: não é importado nem sobrescrito silenciosamente.

Para atravessar processos, o mesmo envelope redacted é persistido atomicamente
em `objects/.events/<object-id-hash>.json`. O watcher usa o workspace ID da
subscription configurada ao reemitir esse envelope; ele nunca confia no alias
de workspace produzido por um subprocesso agent/MCP. A projeção guarda somente
workspace/object IDs, revision, change kind e projection status, sem payloads,
paths canônicos ou secrets. Entrega duplicada pelo fast path e pelo watcher é
aceitável e deduplicada por workspace ID, object ID, revision e projection
status no renderer. Assim o fast path e o watcher não duplicam um envelope,
mas um `ready` de repair na mesma revisão não é descartado após
`projection-error`.

## Data plane do agente

O frontier recebe uma tool genérica de objetos com variantes de action para:

- definir schema;
- criar/alterar/remover entries;
- criar/alterar saved views;
- consultar objetos e payloads;
- verificar ou reparar projeções.

Cada variante possui schema Zod estrito, limite de 64.000 caracteres por valor
string, limites de cardinalidade e validação de
workspace. O retorno inclui object ID, revision e projection status, nunca path
do banco, SQL ou secrets. O mesmo service atende tool e RPC do Desktop.

Orientação compacta é adicionada somente quando o store estruturado existe e o
backend hospeda a tool. A documentação detalhada permanece fora do prompt.

## Tabs e resolver

Targets são uma união discriminada. IDs determinísticos incluem ownership:

- arquivo: workspace, sessão e path normalizado;
- objeto: workspace, object ID e view ID opcional.

Há uma tab preview substituível por scope. Tabs promovidas ou pinned não são
substituídas. Restore é workspace-scoped e sempre repara `activeId` inválido.
Targets de arquivo de outra sessão não atravessam a troca de sessão.

O resolver mantém no máximo 20 payloads. Eviction remove o payload, não apenas a
posição LRU. Load inicial e refresh usam a mesma geração monotônica e o mesmo
AbortController. SWR preserva o último payload bem-sucedido enquanto a nova
revisão carrega; respostas antigas nunca vencem uma geração nova.

## Eventos e watchers

O service publica eventos com workspace ID, object ID, revision, change kind e
projection status. Server-core entrega apenas a clientes inscritos no mesmo
workspace. O renderer deduplica por workspace/object/revision/status.

O watcher de manifests possui uma instância por workspace e refcount de
clientes. Ele ignora SQLite, WAL/SHM, temporários de atomic write e diretórios
ruidosos. Debounce é por path. Ao zerar clientes ou trocar workspace, handles e
timers são encerrados antes de remover o registry entry.

Eventos do service são o caminho rápido. O watcher cobre edição/deleção externa,
reconnect e recuperação, sem emitir um reload para cada write interno.

## Renderer

`AppShell` continua dono da sidebar. A árvore atual e a lista de objetos abrem o
mesmo tab strip. Um registry de conteúdo seleciona componentes por payload:

- Phase A: renderers atuais de image, text/code, Markdown, JSON, Excalidraw,
  PDF, audio e datatable;
- Phase B: table, Kanban, calendar, timeline, gallery e list.

PDF, áudio e tipos não suportados inline mantêm o routing já especificado. A
primeira fase não adiciona fallback local inseguro ao WebUI; surfaces ainda não
suportadas retornam estado explícito.

## Views

Saved views armazenam filtros aninhados, search, multi-sort, column visibility e
settings do adapter. A query é avaliada no shared domain para agente e UI
receberem o mesmo resultado.

No U5, o contrato persistido é `schemaVersion: 1` e estrito. O action adicional
`query-object` aceita exatamente uma saved view por ID ou uma config inline e
chama o mesmo evaluator usado pela table. Inputs legacy do placeholder Phase A
permanecem compatíveis no frontier v1, mas são normalizados para v1 antes da
gravação. Sort usa a ordem canônica da entry como desempate; relation values
continuam IDs e recebem labels dos payloads relacionados somente na leitura. A
query avalia todas as entries do snapshot canônico antes de limitar a resposta
a 200 rows e inclui `totalEntries`/`truncated`, evitando falso vazio por corte
antecipado. Projeção stale é reparada antes de abrir o snapshot; se houver nova
divergência concorrente, o fallback reconstrói das rows sem escrever dentro da
transação de leitura.

A table não confirma de forma otimista. O RPC `upsert-entries` precisa retornar
a revisão commitada e o editor permanece em `awaiting-revalidation` até o SWR
observar revisão igual ou superior com o valor esperado. Validação local,
resposta sem envelope de commit e exceção de transporte preservam o draft e não
produzem estado visual de sucesso.

Os seis adapters consomem um payload comum. Kanban conserva a mutação original
durante optimistic update e reverte tanto em resposta rejeitada quanto em
exceção de transporte. Calendar é primeiro um adapter genérico de date/datetime;
sync de Google Calendar apenas materializa dados nesse contrato.

## Integrações

Composio fornece catálogo e metadata de conexão long-tail. Craft sources/OAuth e
credential storage continuam autoridades. Conexão saudável exige source test e
probe em uma sessão compatível que observe as tools esperadas.

Gmail e Google Calendar usam adapters nativos porque checkpoint, idempotência,
timezone, cancelamento e relacionamento são invariantes do domínio. Listas de
inbox carregam somente metadata; HTML completo é hidratado sob demanda e passa
pelo sanitizer existente.

## Falhas e recuperação

- Migration futura desconhecida bloqueia writes, preserva reads possíveis e
  retorna erro acionável.
- Falha de manifest após commit mantém canonical visibility e agenda repair.
- Falha da projeção durável de evento após commit retorna `projection-error` e
  publica o mesmo status no fast path; nunca reporta rollback do commit canônico.
- Falha de watcher não invalida mutations; reconnect restabelece uma subscription
  e emite uma única invalidação por workspace para recarregar lista e objeto
  ativo. Falha de revalidation conserva o payload stale e mostra erro com retry.
- Falha de provider preserva checkpoint e dados visíveis.
- Token incremental expirado troca para full reconciliation idempotente sem
  limpar o estado atual antes do replacement.

## Segurança

- Paths e payloads passam pelos guards de workspace existentes.
- Queries e mutations são bounded e Zod-validated.
- Secrets nunca entram em manifest, object payload, renderer ou logs.
- HTML continua na boundary sanitizada do preview.
- `vibe-security` e Coderabbit são gates antes de qualquer push/merge.

## Estratégia de rollout

Phase A é local-first e Electron-first. Ela não encerra até um agente real criar
e atualizar um objeto e o sidebar mostrar ambas as revisões sem restart. Cada
fase posterior depende de auditor GO, testes focados, validação OpenSpec e smoke
real correspondente.
