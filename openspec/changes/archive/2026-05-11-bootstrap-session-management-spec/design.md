## Context

Craft mantém sessões como a fronteira de isolamento entre workspace, histórico persistido e backend de agente. A sessão tem metadados persistidos em JSONL, mensagens append-only, diretórios auxiliares para anexos/planos/dados/downloads e eventos enviados ao renderer/CLI via RPC push.

O `SessionManager` é o orquestrador de runtime: cria sessões, restaura estado de disco, instancia o backend compatível, aplica fontes, processa eventos do agente, persiste mensagens e propaga cancelamento. Os tipos base vivem em `packages/core` e `packages/shared/src/sessions`, enquanto os handlers RPC expõem criação, envio de mensagem, comandos de sessão, export/import e transferência.

## Goals / Non-Goals

**Goals:**

- Definir o contrato de sessão para id estável, workspace, status, labels, metadados e persistência.
- Definir histórico de mensagens como sequência append-only, com ordem estável para replay e UI.
- Definir streaming como eventos ordenados para texto, tool start/result, reasoning/status e conclusão.
- Definir branch/rollback como operações explícitas sobre ponto histórico de mensagem.
- Definir anexos como arquivos vinculados à sessão e a turns/mensagens específicas.
- Definir cancelamento e shutdown como propagação até o backend ativo e liberação de recursos.
- Definir transferência como export/import de histórico e arquivos, quando disponível.

**Non-Goals:**

- Não muda providers de agente nem mistura contratos de Claude, Pi ou Hermes.
- Não define UI visual específica para lista de sessões, labels, status ou confirmação de rollback.
- Não muda o formato de transporte RPC além de documentar o contrato existente.
- Não exige transferência remota quando o deployment não oferecer esse fluxo.

## Decisions

### SessionManager como dono do runtime

O `SessionManager` SHALL ser o ponto único que conecta sessão persistida, backend ativo, fila de mensagens, eventos de stream e shutdown. Isso evita múltiplos backends simultâneos para a mesma sessão e mantém o renderer como consumidor de eventos, não como fonte de verdade.

Alternativa considerada: deixar cada handler RPC gerenciar backend e persistência diretamente. Isso foi rejeitado porque fragmenta cancelamento, branch, locks de conexão e deduplicação de eventos.

### JSONL como fonte persistida da sessão

Cada sessão SHALL persistir metadados no header e mensagens nas linhas seguintes do `session.jsonl`. Arquivos auxiliares SHALL ficar no diretório da sessão, incluindo anexos, planos, dados, respostas longas e downloads.

Alternativa considerada: armazenar metadados e mensagens em arquivos separados. O formato atual é mantido porque permite listagem rápida via header e replay resiliente do histórico completo.

### Tipos compartilhados como contrato público

`Session`, `Message`, `ToolUse`, `ToolResult`, `ReasoningEvent` e anexos SHALL ser representados por tipos compartilhados em `packages/core` e/ou `packages/shared`, com campos transitórios separados de campos persistidos. O storage SHALL persistir apenas dados necessários para restauração.

Alternativa considerada: tipos privados por backend. Isso foi rejeitado porque renderer, CLI, storage e handlers RPC precisam do mesmo envelope de evento/mensagem.

### Statuses e labels configuráveis por workspace

Status e labels SHALL ser metadados de sessão controlados por workspace. Atualizações desses campos SHALL ser independentes do stream do backend e SHALL emitir eventos próprios para sincronizar renderer e listas.

Alternativa considerada: status automático derivado do backend. Isso foi rejeitado porque status é workflow do usuário/workspace, não estado técnico de processamento.

### Branch e rollback ancorados por mensagem

Branch SHALL criar uma nova sessão a partir de uma mensagem histórica da sessão origem, preservando o histórico até o ponto escolhido e mantendo metadados de origem necessários para branch nativo do provider. Rollback SHALL truncar a sessão existente até o ponto escolhido e exigir confirmação na UI.

Alternativa considerada: branch por índice visual sem id de mensagem. Isso foi rejeitado porque ids de mensagem são mais estáveis para persistência, replay e sidecars de anchors nativos.

### Transferência por bundle ou resumo remoto

Transferência entre workspaces SHALL preservar histórico e arquivos quando feita por bundle completo. Quando só houver handoff remoto resumido, o sistema SHALL preservar metadados compatíveis e injetar resumo na sessão destino sem fingir que anexos/histórico completo foram copiados.

Alternativa considerada: sempre preservar `sdkSessionId` e cwd originais. Isso foi rejeitado porque transfers cross-server podem não ter paths, credenciais ou provider compatíveis.

## Risks / Trade-offs

- [Eventos duplicados ou fora de ordem] -> Deduplicar por `toolUseId`, usar timestamps monotônicos onde aplicável e emitir complete somente depois de flush de deltas pendentes.
- [Perda de mensagens em crash] -> Persistir após mensagens finais e resultados de tools, com escrita JSONL atômica.
- [Branch incorreto por provider incompatível] -> Validar provider/backend antes da criação e fazer rollback da sessão recém-criada se a preflight falhar.
- [Rollback destrutivo] -> Exigir confirmação explícita na UI antes de truncar histórico.
- [Transferência incompleta] -> Retornar warnings para incompatibilidade de sources/conexões e diferenciar bundle completo de handoff resumido.

## Migration Plan

Esta change é bootstrap documental. Não há migração de dados.

Para mudanças futuras, atualizar esta capability antes de alterar formato de sessão, eventos RPC, branch/rollback, anexos ou transferência. Rollback da change documental consiste em remover os artefatos desta pasta antes do archive.

## Open Questions

- O rollback de sessão existente deve manter um snapshot recuperável antes do truncamento?
- Reasoning deve continuar representado como status/info/texto derivado dos backends ou ganhar evento persistido dedicado?
- Transfer remoto resumido deve declarar explicitamente no payload que anexos não foram preservados?
