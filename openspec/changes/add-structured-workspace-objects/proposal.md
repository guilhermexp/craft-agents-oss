## Why

O Craft já possui preview de arquivos, sidebar persistente, sources OAuth,
watchers, tasks e renderers ricos, mas essas superfícies não compartilham um
modelo de objetos que agente e usuário possam editar juntos. O resultado é que
CRM, inbox, calendário e views especializadas tenderiam a nascer como silos ou
como tools específicas de UI.

O DenchClaw demonstra o loop desejado de agente → dados/arquivos → watcher →
view, porém a validação do upstream também encontrou cache sem eviction real,
cancelamento parcial e projeções de identidade mais frágeis que a documentação.
O Craft precisa incorporar o padrão com contratos explícitos de persistência,
revisão, reatividade e teardown.

## What Changes

- Adicionar um domínio local-first de objetos estruturados com SQLite canônico,
  campos tipados, relações, views, histórico, migrations e projeção de leitura
  reconstruível.
- Expor um único data plane genérico e validado aos agentes, sem SQL cru nem
  tools por renderer, e ativar orientação compacta somente em workspaces
  estruturados.
- Manter manifests legíveis como projeção reparável, sem transformá-los em uma
  segunda autoridade.
- Evoluir a sidebar direita existente com tabs determinísticas, cache realmente
  limitado, SWR, cancelamento, eventos revisionados e watcher com teardown.
- Acrescentar table editável, saved views, Kanban, calendar, timeline, gallery e
  list sobre o mesmo payload em fases posteriores.
- Reutilizar sources/OAuth para catálogo Composio e sincronizações nativas de
  Gmail e Google Calendar, mantendo secrets fora do renderer e dos manifests.
- Importar e corrigir os sete documentos de referência em `docs/denchclaw/`.

## Capabilities

### New Capabilities

- `structured-workspace-objects`: modelo, storage, projeções, reatividade,
  views, inbox, calendário e relacionamentos.

### Modified Capabilities

- `audio-preview-and-markdown`: adiciona tabs persistentes e dispatch modular
  de conteúdo sem regredir o roteamento atual de arquivos.
- `session-tools-mcp`: adiciona o data plane genérico, orientação contextual e
  probe de conexão visível ao backend.
- `workspace-and-sources`: adiciona catálogo Composio e contratos de sync que
  continuam subordinados ao credential storage do Craft.

## Phases

1. **Foundation and persistent preview:** storage, manifests, agent data plane,
   tabs/resolver, watcher e integração real no Electron.
2. **Editable object views:** table, saved views e adapters de seis views.
3. **Integration discovery:** catálogo Composio e health probe ponta a ponta.
4. **Inbox and calendar:** Gmail, Google Calendar e relacionamentos.

Cada fase exige auditor GO antes da seguinte. A primeira fase é a única
autorizada para implementação imediata por esta execução.

## Impact

- Novo domínio em `packages/shared/src/workspace-objects/`.
- Nova tool/handler no frontier de `packages/session-tools-core` e exposição no
  `packages/session-mcp-server`.
- Novos handlers/eventos em `packages/server-core`, preload e tipos Electron.
- Evolução de `AppShell`, `SessionFilesSection` e dos renderers já existentes.
- Novas views estruturadas no renderer em fases posteriores.
- Dados locais em `objects/objects.sqlite` e manifests em
  `objects/<object-slug>/object.yaml` por workspace.

## Dependencies

- `harden-right-sidebar-inline-preview` é a baseline de UI e não será
  reimplementada.
- As fases de integração aguardam a conclusão ou reconciliação explícita de
  `harden-credential-storage`.

## Non-goals

- Dench Cloud, `.dench.app`, uma bridge de apps ou acoplamento a provider/modelo.
- Paridade WebUI/viewer/remote na primeira fase.
- Copiar o god-component e todos os renderers do DenchClaw.
- Substituir a sidebar atual ou alterar o comportamento dos viewers
  especializados de PDF e áudio.
