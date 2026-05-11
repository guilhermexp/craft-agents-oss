## Context

Craft já possui um fluxo nativo de reuniões que detecta links do Google Meet no BrowserView interno, permite convidar Hermes pela toolbar e delega a entrada/transcrição para o plugin `google_meet` do runtime Hermes vendorizado. O runtime é gerado em `apps/electron/resources/vendor/hermes` no desenvolvimento e usa `HERMES_HOME` app-scoped para estado, autenticação dedicada do bot e artefatos de reunião.

A autenticação Google aparece em duas camadas: o BrowserView usa a sessão Google do perfil do navegador para abrir Meet, enquanto fontes Google/Drive/Calendar usam OAuth para acessar APIs do Workspace. A aba de arquivos do workspace expõe arquivos locais do workspace e deve coexistir com arquivos Drive/Workspace autenticados para que Hermes receba contexto sem expor tokens.

## Goals / Non-Goals

**Goals:**
- Definir o contrato de convite do Hermes ao Google Meet pela toolbar do BrowserView interno.
- Definir que o Meet bot roda como subprocesso do runtime Hermes vendorizado, sem fallback inseguro no app empacotado.
- Definir o contrato de autenticação Google/OAuth e privacidade de tokens.
- Definir como arquivos do Drive/Workspace ficam disponíveis como contexto para Hermes.
- Definir que uma reunião vira sessão Craft com contexto do convite e libera recursos ao terminar.

**Non-Goals:**
- Implementar uma nova UI ou refatorar a navegação existente.
- Reescrever o plugin `google_meet` upstream do Hermes.
- Definir gravação automática sem consentimento ou entrada automática sem link explícito.
- Substituir a capability existente `hermes-embed`.

## Decisions

1. O convite parte do BrowserView interno.

   Rationale: o BrowserView já conhece URL, título, perfil do navegador e instância ativa. Isso permite reutilizar uma reunião já aberta em vez de navegar outro browser.

   Alternative considered: iniciar o bot apenas pela página de reuniões. Isso continua válido como fallback/manual, mas perde o contexto imediato da toolbar.

2. O bot roda como subprocesso do Hermes vendorizado.

   Rationale: o plugin `google_meet` já controla ciclo de vida via `process_manager`, usa Playwright/Chromium e grava estado sob `HERMES_HOME/workspace/meetings`. Manter o bot dentro do runtime vendorizado evita depender de instalações globais do usuário.

   Alternative considered: usar um binário standalone `hermes` do PATH. Isso quebra isolamento do Craft e deve falhar fechado no app empacotado.

3. A autenticação Google usa OAuth para APIs e sessão de navegador para o Meet.

   Rationale: Google Meet em BrowserView depende do login interativo do Google, enquanto Drive/Calendar/Workspace APIs exigem OAuth com escopos explícitos. Tokens OAuth e cookies de sessão não devem aparecer em logs.

   Alternative considered: reaproveitar tokens globais do usuário ou `~/.hermes`. Isso viola o isolamento app-scoped do Hermes embutido.

4. Arquivos do Drive/Workspace são contexto, não runtime global.

   Rationale: a workspace files tab e as sources autenticadas devem listar recursos vinculados ao workspace do usuário e entregá-los a Hermes como contexto de sessão. Isso evita tornar arquivos ou credenciais globais entre workspaces.

   Alternative considered: montar Drive como filesystem global. Isso ampliaria escopo de acesso e dificultaria autorização por workspace.

5. Reunião vira sessão Craft com contexto do convite.

   Rationale: participantes, link e agenda precisam acompanhar a reunião para que Hermes produza transcrição, resumo e tarefas com contexto. O ciclo de vida deve passar por RPC/IPC para status, transcrição e parada.

   Alternative considered: manter reunião apenas como processo Hermes avulso. Isso ocultaria status da UI e dificultaria limpeza de recursos.

## Risks / Trade-offs

- Runtime Hermes ausente ou incompleto -> o comando de convite deve falhar fechado com erro claro, sem fallback para `hermes` global.
- Playwright/Chromium ou dependências do plugin ausentes -> o bundle deve incluir as dependências e o smoke test deve validar import/preflight do Meet bot.
- Conta Google do bot sem autenticação dedicada -> o convite deve falhar com mensagem acionável e não usar a conta do organizador como bot silencioso.
- Tokens/cookies em logs -> logs devem registrar apenas estado operacional redigido, nunca access tokens, refresh tokens, cookies ou bearer tokens.
- Reunião encerrada sem limpeza -> `meetings:stop` e hooks de fim de sessão devem parar subprocessos e limpar ponteiros ativos.

## Migration Plan

Esta é uma change de bootstrap retroativo, sem migração de dados obrigatória. Mudanças futuras na capability `meetings` devem atualizar esta spec antes de alterar handlers, UI, bundle Hermes ou documentação operacional.

Rollback: remover ou arquivar a change OpenSpec se a capability for renomeada antes de ser aplicada; não há alteração de código nesta change.

## Open Questions

- O contrato final de participantes e agenda virá diretamente do Calendar/Meet APIs ou de metadados do convite já presentes na sessão?
- A transcrição placeholder atual deve virar requisito de captura real em uma change separada?
- A listagem Drive/Workspace deve ser uma extensão da workspace files tab existente ou uma aba própria de sources Google?
