## ADDED Requirements

### Requirement: Structured workspaces have one canonical object model

O sistema SHALL persistir objects, typed fields, entries, values, relations,
statuses, linked documents, saved views e action history em um schema SQLite
versionado por workspace. Inicialização, migrations e seeds SHALL ser
idempotentes e identificadores de sistema MUST permanecer estáveis.

#### Scenario: Inicialização repetida preserva identidade

- **GIVEN** um workspace estruturado já inicializado
- **WHEN** o runtime inicializa o object store novamente
- **THEN** migrations e seeds não duplicam records nem alteram stable IDs
- **Test:** `integration`

#### Scenario: Mutação inválida não grava parcialmente

- **GIVEN** uma mutação com múltiplas entries e um value inválido
- **WHEN** o service valida e tenta aplicar a operação
- **THEN** a transação inteira é rejeitada sem revisão ou evento de sucesso
- **Test:** `integration`

### Requirement: Object reads use a reconstructable revisioned projection

O sistema SHALL manter um payload tabular indexado com a revisão das rows
normalizadas e MUST reconstruí-lo das rows canônicas quando estiver ausente ou
stale. Ausência da projeção MAY reduzir performance, mas MUST NOT reduzir
correção ou visibilidade.

#### Scenario: Projeção ausente é reconstruída

- **GIVEN** um objeto canônico sem seu payload projetado
- **WHEN** o objeto é consultado
- **THEN** o runtime retorna dados equivalentes às rows normalizadas e recria a projeção
- **Test:** `integration`

#### Scenario: Revisão projetada está stale

- **GIVEN** um payload cuja source revision é anterior à revisão do objeto
- **WHEN** a consulta ocorre
- **THEN** o payload stale não é tratado como atual e é reconstruído
- **Test:** `unit`

### Requirement: Filesystem manifests are recoverable projections

SQLite SHALL ser a única autoridade de identidade. O manifest em
`objects/<slug>/object.yaml` SHALL carregar stable ID e revision, SHALL ser
escrito atomicamente, MUST ser integralmente validado por schema estrito e MUST
ser reparado quando ausente. Divergência de stable
ID MUST manter o objeto canônico visível e produzir conflito acionável.

#### Scenario: Manifest deletado é reparado

- **GIVEN** um objeto canônico cujo manifest foi removido
- **WHEN** o watcher ou uma leitura detecta a ausência
- **THEN** o runtime recria idempotentemente o manifest sem alterar a revisão do objeto
- **Test:** `integration`

#### Scenario: Stable ID divergente não substitui identidade

- **GIVEN** um manifest cujo stable ID não corresponde ao objeto do diretório
- **WHEN** o runtime valida a projeção
- **THEN** ele preserva o objeto canônico, não importa o manifest e mostra o conflito
- **Test:** `integration`

### Requirement: Canonical commit and manifest projection form a recoverable protocol

O service SHALL commit canonical rows e read projection antes de projetar o
manifest. Depois do commit ele SHALL publicar exatamente um evento revisionado
com status `ready` ou `projection-error`; ambos MUST permitir reload do objeto
canônico e `projection-error` MUST expor repair state. O envelope MUST possuir
uma projeção durável redacted observável por outros processos; a bridge MUST
substituir aliases do produtor pelo workspace ID da subscription configurada.
Fast path e watcher MAY entregar o mesmo envelope físico, mas o renderer MUST
deduplicar pela chave workspace/object/revision/status. Um repair `ready` na
mesma revisão após `projection-error` MUST ser preservado.

#### Scenario: Commit e manifest concluem

- **WHEN** uma mutação válida e seu manifest concluem
- **THEN** o service publica um evento `ready` com workspace, object e revision
- **Test:** `integration`

#### Scenario: Manifest falha após commit

- **GIVEN** uma revisão canônica já commitada
- **WHEN** a escrita ou validação do manifest falha
- **THEN** o service publica `projection-error`, mantém o objeto visível e permite repair idempotente
- **Test:** `integration`

#### Scenario: Agent/MCP usa alias de diretório como workspace

- **GIVEN** um subprocesso grava evento com workspace ID derivado do basename
- **WHEN** o watcher entrega o envelope ao cliente inscrito pelo ID configurado
- **THEN** a bridge reemite object/revision/status no scope configurado sem expor payload ou secret
- **Test:** `integration`

#### Scenario: Projeção durável do evento falha após commit

- **GIVEN** uma revisão canônica já commitada
- **WHEN** a escrita do envelope cross-process falha
- **THEN** a mutation retorna a revisão com `projection-error`, mantém o objeto visível e usa o evento in-process como único fallback, sem alegar rollback ou segunda entrega durável
- **Test:** `integration`

### Requirement: Object events and watchers are workspace-scoped

Eventos SHALL carregar workspace ID, object ID, revision, kind e projection
status. Watchers SHALL ignorar DB/WAL/SHM e temporários, aplicar debounce por
path, reference-count clients e encerrar handles e timers ao perder o último
cliente.

#### Scenario: Evento de outro workspace é ignorado

- **GIVEN** um cliente inscrito no workspace A
- **WHEN** uma revisão ocorre no workspace B
- **THEN** nenhuma invalidação do workspace B chega ao cliente do workspace A
- **Test:** `integration`

#### Scenario: Último cliente sai

- **GIVEN** um watcher com um cliente restante
- **WHEN** esse cliente cancela a inscrição
- **THEN** handles, debounce timers e registry entry são encerrados
- **Test:** `unit`

### Requirement: One payload powers all object views

Table, Kanban, calendar, timeline, gallery e list SHALL consumir o mesmo payload
canônico. Trocar adapter MUST NOT migrar dados nem alterar object/entry IDs.

#### Scenario: Coleção alterna entre seis views

- **GIVEN** uma saved view válida
- **WHEN** o usuário alterna entre os seis adapters
- **THEN** todos exibem o mesmo conjunto revisionado de entries e stable IDs
- **Test:** `integration`

### Requirement: Saved views and table edits are durable and typed

Saved views SHALL preservar filtros aninhados, search, multi-sort, column
visibility e settings do adapter. Table edits SHALL validar pelo field type,
resolver relation labels por stable ID e somente confirmar sucesso após commit.
Migration v3 SHALL adquirir o writer lock antes de ler e normalizar legacy
saved views, reavaliando updates concorrentes sob a mesma transação. O config
normalizado MUST ocupar no máximo 64.000 bytes UTF-8 após JSON escaping e
wrapper completo e MUST poder ser salvo novamente. Migration v4 SHALL reavaliar
rows estritas v1 já marcadas como v3: uma config dentro do limite MUST
permanecer inalterada e uma config oversized MUST ser reorçada, persistida e
reprojetada antes do marker v4. Filtros de
relation SHALL comparar stable ID e label corrente, usando OR para operadores
positivos e AND para operadores negados.
`query-object` SHALL avaliar o snapshot canônico completo antes de limitar a
resposta a 200 entries e SHALL retornar `totalEntries` e `truncated`. O repair
de projeção stale SHALL ser tentado antes do snapshot de leitura; se o writer
lock estiver ocupado, a query MUST continuar com fallback read-only. O retorno
MUST limitar relation labels aos IDs referenciados pelas entries devolvidas.
Contenção MUST reconhecer códigos Bun `SQLITE_BUSY`/`SQLITE_LOCKED` e primary
`errcode` 5/6 de `node:sqlite`; erros SQLite não relacionados MUST propagar.
A escolha do label relation MUST ter `query.ts` como autoridade única (primeiro
text na ordem canônica, senão primeiro field), enquanto o storage MUST resolver
fields e candidate IDs em batches bounded no mesmo snapshot, sem N+1.
Erros de relation options MUST usar códigos estáveis para resposta inválida,
snapshot stale, mudança durante load e transporte. O renderer MUST traduzir o
código como texto principal e MAY exibir detalhe técnico de transporte apenas
como texto secundário. As variantes não-transport MUST excluir `detail` do tipo
e o renderer MUST condicionar detalhe a `code === 'transport'`. Field editor busy MUST usar key dedicada em todos os
locales, distinta da key de salvar view.

#### Scenario: Saved view é restaurada

- **WHEN** uma view com filtros aninhados e columns ocultas é reaberta
- **THEN** query e apresentação correspondem ao estado salvo
- **Test:** `integration`

#### Scenario: Update concorrente vence migration v3

- **GIVEN** uma legacy saved view e outro writer atualizando-a para config v1 válida
- **WHEN** migration v3 aguarda e adquire o writer lock
- **THEN** ela relê a row sob o lock e não sobrescreve a atualização concorrente
- **Test:** `integration`

#### Scenario: Legacy config Unicode permanece resavável

- **GIVEN** um config legacy com Unicode multibyte e caracteres escapáveis acima do limite
- **WHEN** migration v3 o normaliza
- **THEN** o JSON final completo ocupa no máximo 64.000 bytes UTF-8, não termina em surrogate dividido e pode ser salvo novamente
- **Test:** `unit`

#### Scenario: Migration v4 recupera strict v1 oversized já marcado

- **GIVEN** um workspace com marker v3 e uma saved view estrita v1 cujo JSON UTF-8 excede 64.000 bytes
- **WHEN** o repository reabre sob schema v4
- **THEN** a row e a projeção são reorçadas para no máximo 64.000 bytes, o resave passa e o marker avança para v4
- **Test:** `integration`

#### Scenario: Normalização preserva strict v1 dentro do budget

- **GIVEN** uma saved view estrita v1 cujo JSON UTF-8 já cabe no limite
- **WHEN** o normalizador avalia a view
- **THEN** id, nome e config permanecem inalterados
- **Test:** `unit`

#### Scenario: Relation options reutilizam a regra compartilhada de label

- **GIVEN** até 200 fields ordenados e candidate IDs bounded
- **WHEN** relation options são lidas no snapshot
- **THEN** storage usa o selector de `query.ts` e resolve valores em batch sem N+1 ou scan global
- **Test:** `unit`

#### Scenario: Relation options falham sem headline interna

- **WHEN** load recebe resposta inválida, snapshot stale, mudança concorrente ou erro de transporte
- **THEN** o estado usa código estável, o alert mostra tradução local e somente o transporte mantém detalhe técnico secundário opcional
- **Test:** `unit`

#### Scenario: Detalhe relation pertence somente ao transporte

- **WHEN** o alert recebe qualquer um dos quatro códigos estáveis
- **THEN** cada código resolve seu headline traduzido, somente `transport` aceita/renderiza detalhe e as demais variantes ignoram dado técnico residual
- **Test:** `unit`

#### Scenario: Field edit permanece busy

- **WHEN** uma edição de field aguarda commit
- **THEN** o botão usa `workspaceObjectSavingField` nos locales suportados e não reutiliza `workspaceObjectSavingView`
- **Test:** `unit`

#### Scenario: Relation filtra por ID estável e label

- **WHEN** filtros relation positivos ou negados usam o stable ID enquanto existe label corrente
- **THEN** positivos aceitam match no ID ou label e negados excluem match em qualquer representação
- **Test:** `unit`

#### Scenario: Field edit inválido é rejeitado

- **WHEN** um editor envia valor incompatível com o field type
- **THEN** o editor mostra erro e nenhuma revisão de sucesso é publicada
- **Test:** `unit`

#### Scenario: Match após o limite de resposta continua visível

- **GIVEN** um objeto com mais de 200 entries e o único match após a entry 200
- **WHEN** `query-object` aplica search ou filtro
- **THEN** o evaluator considera o conjunto inteiro, retorna o match e informa o total/truncamento da página
- **Test:** `integration`

#### Scenario: Projeção stale durante query não promove snapshot de leitura

- **GIVEN** uma projeção stale e um writer concorrente após o snapshot começar
- **WHEN** `query-object` precisa reconstruir o payload canônico
- **THEN** a leitura usa rows do próprio snapshot sem tentar escrever nem produzir `SQLITE_BUSY_SNAPSHOT`
- **Test:** `integration`

#### Scenario: Writer lock ocupado não bloqueia query canônica

- **GIVEN** uma projeção stale e outro writer mantendo `BEGIN IMMEDIATE`
- **WHEN** o repair best-effort não adquire o lock
- **THEN** `query-object` continua pelo snapshot read-only e retorna as rows canônicas
- **Test:** `integration`

#### Scenario: Runtime SQLite reporta contenção em formatos distintos

- **GIVEN** Bun reportando `SQLITE_BUSY`/`SQLITE_LOCKED` ou `node:sqlite` reportando primary `errcode` 5/6
- **WHEN** o repair best-effort tenta adquirir o writer lock
- **THEN** a query usa fallback read-only, enquanto qualquer erro SQLite não relacionado é propagado
- **Test:** `unit`

#### Scenario: Relation labels respeitam o limite da página

- **GIVEN** mais de 200 entries com referências relacionais únicas
- **WHEN** `query-object` devolve a primeira página bounded
- **THEN** `relationLabels` contém somente IDs usados pelas entries dessa página
- **Test:** `integration`

### Requirement: Kanban mutations distinguish persistence failure from projection repair

Kanban SHALL agrupar por field configurável, SHALL explicar configuração
incompatível e MUST restaurar a mutação original quando a persistência falhar
por resposta ou transporte. Um envelope com object ID e revisão canônicos mais
`projection-error` MUST manter a mutação aguardando revalidation, MUST mostrar
warning de repair separado e MUST NOT alegar rollback do commit.
Retry e envelopes de commit MUST preservar warning anterior até revalidation
`ready` suficiente; `projection-error` posterior MAY substituí-lo por revisão
mais nova.

#### Scenario: Group field está ausente

- **WHEN** Kanban abre sem field compatível configurado
- **THEN** ele mostra a configuração necessária em vez de um board vazio
- **Test:** `unit`

#### Scenario: Transporte falha após optimistic move

- **WHEN** um card é movido e o request lança erro de transporte
- **THEN** card e dados locais retornam à coluna original e o erro permanece visível
- **Test:** `integration`

#### Scenario: Commit canônico requer repair de projeção

- **WHEN** o move retorna object ID e revisão canônicos com `projection-error`
- **THEN** o card aguarda confirmação canônica, mostra warning separado e limpa o warning somente após payload `ready` na revisão commitada
- **Test:** `integration`

#### Scenario: Retry falha enquanto repair anterior segue pendente

- **GIVEN** um warning `projection-error` confirmado na revisão 5
- **WHEN** a mesma entry inicia retry e recebe rollback ou envelope de commit sem revalidation
- **THEN** o warning da revisão 5 permanece até payload `ready` de revisão 5 ou superior
- **Test:** `unit`

### Requirement: Gmail sync is resumable and idempotent

O sync SHALL checkpointar antes de cada page, deduplicar por provider ID,
respeitar rate limits e excluir endereços do usuário autenticado da criação de
counterparts.

#### Scenario: Sync interrompe após checkpoint

- **GIVEN** uma page checkpointada e parcialmente processada
- **WHEN** o sync retoma
- **THEN** pages anteriores não repetem e a page corrente não duplica messages ou interactions
- **Test:** `integration`

#### Scenario: Próprio usuário aparece nos recipients

- **WHEN** uma message inclui um alias da conta autenticada
- **THEN** esse alias não cria relationship profile
- **Test:** `unit`

### Requirement: Inbox hydrates full content on demand

List payloads SHALL conter somente metadata e preview. Body HTML SHALL ser
buscado ao selecionar a message e MUST atravessar a boundary sanitizada
existente antes de renderizar.

#### Scenario: Inbox lista mensagens

- **WHEN** o inbox carrega uma page
- **THEN** nenhum body HTML completo integra o list payload
- **Test:** `integration`

#### Scenario: Mensagem é aberta

- **WHEN** o usuário seleciona uma message
- **THEN** o body é hidratado sob demanda e renderizado sanitizado
- **Test:** `integration`

### Requirement: Calendar sync preserves provider semantics

O sync SHALL preservar provider ID, timezone, cancellation, recurring-instance
identity e incremental token. Token expirado SHALL iniciar full reconciliation
idempotente sem remover dados visíveis antes da substituição.

#### Scenario: Evento cancelado chega incrementalmente

- **WHEN** o provider envia cancellation para um evento conhecido
- **THEN** a entry correta é marcada cancelada sem criar duplicata
- **Test:** `integration`

#### Scenario: Incremental token expira

- **WHEN** o provider rejeita o sync token
- **THEN** o runtime agenda full reconciliation e conserva o calendar atual até convergir
- **Test:** `integration`

### Requirement: Relationships aggregate by counterpart with provenance

Interactions de email, calendar e meetings SHALL agregar por identidade externa
normalizada, SHALL preservar source provenance e MUST excluir identidades do
usuário autenticado.

#### Scenario: Email e meeting compartilham counterpart

- **GIVEN** um email e uma meeting com a mesma identidade externa
- **WHEN** o profile é consultado
- **THEN** ambas aparecem em um profile com provenance separado por source
- **Test:** `integration`
