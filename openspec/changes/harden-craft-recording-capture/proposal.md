# Harden Craft-native meeting recording capture

## Why

A gravação Craft-native escreve o `.webm` incrementalmente e sobrevive a falha de
transcrição, resumo e video-analysis. Mas ela só é preservada quando termina pelo
botão Parar ou pelo fim do stream: um quit, crash ou destroy de pane com gravação
ativa deixa o arquivo sem referência em `record.recording.path`, e o sweep de
órfãos o apaga no boot seguinte. Verificado por teste com os serviços reais: os
bytes estavam no disco com o record `running` e desapareceram após um restart.

Duas causas somadas: `shutdown()` filtra `captureMode !== 'craft'`
(`apps/electron/src/main/meetings/meeting-service.ts:518`) e o único `finalize`
existe no handler IPC (`apps/electron/src/main/handlers/meetings.ts:131`), então
nada no main sela a captura sem o renderer.

Em paralelo, a janela que hospeda a call é adotável por qualquer sessão de agente
local: `findReusableUnboundInstance` escolhe panes `manual` não vinculados
preferindo a visível (`apps/electron/src/main/browser-pane-manager.ts:1595-1604`)
e o `SessionManager` chama `createForSession` sem `allowReuseManual: false`
(`packages/server-core/src/sessions/SessionManager.ts:3686`, `:3746`, `:4000`).
O agente navega a janela do Meet, o usuário cai da call e a gravação é cortada.
Nada no pane manager sabe que aquele pane está gravando.

Por fim, a superfície de gravação não mostra tempo decorrido, o que torna
invisível justamente o estado em que essas perdas acontecem.

## What Changes

- Referenciar o `.webm` no record desde o primeiro byte, com marcação de parcial,
  para que o sweep de órfãos preserve gravações interrompidas em vez de apagá-las.
- Selar gravação Craft no `before-quit` e no `app:relaunch`, sem depender do
  renderer, movendo o mime escolhido para o payload de prepare.
- Marcar o pane com gravação ativa como não adotável, desvincular um pane travado
  já ligado a uma sessão, e expor esse estado no DTO do pane.
- Encaminhar destroy e troca de perfil do pane por um release hook que sela a
  gravação antes do teardown.
- Mostrar tempo decorrido na toolbar do pane e na sidebar de reuniões, marcar
  gravações interrompidas, e reduzir as ações da lista a ícones com rótulo
  acessível.
- Medir, antes de qualquer UI, se a janela escondida continua produzindo chunks e
  se a navegação do pane encerra o track — as duas premissas que hoje são
  inferência.
- Avisar quando nenhuma faixa de áudio é capturada e, confirmada a ausência da
  voz local em call real, mixar o microfone sem tornar o mic obrigatório.

## Decisions

- **D-01 — Referência antes de bytes:** o record MUST apontar para o `.webm`
  desde o prepare, com `recording.partial` verdadeiro; selar apenas limpa a
  marca. Um parcial referenciado nunca é órfão.
- **D-02 — Seal sem renderer:** o mime SHALL viajar no prepare para que o main
  consiga selar sozinho no quit. Perder o último timeslice (~1s) é aceito e
  documentado; o renderer morrendo não tem como dar flush.
- **D-03 — Falha isolada por gravação:** uma stream com erro MUST NOT impedir o
  seal das outras no shutdown.
- **D-04 — Lock no pane, não flag no agente:** a proteção SHALL ser um
  `captureLock` na instância consultado pela adoção, não `allowReuseManual: false`
  nos callsites — desligar reuso mataria o fluxo intencional de continuar numa
  janela aberta pelo usuário.
- **D-05 — Desvincular, não falhar:** pane travado já vinculado a uma sessão MUST
  ser desvinculado para que o caminho de criação existente entregue janela nova;
  a sessão não recebe erro.
- **D-06 — Medir antes de decidir:** F0 MUST responder se a janela escondida
  continua gravando e se a navegação encerra o track. Um resultado negativo abre
  requirement P0 nova antes da UI.
- **D-07 — Áudio degrada, não aborta:** ausência de faixa de áudio ou falha ao
  obter o microfone MUST avisar e continuar gravando. Só a ausência de vídeo
  aborta, como hoje.
- **D-08 — Capability única:** as garantias de propriedade do pane são enunciadas
  na capability `meetings` e implementadas no `browser-pane-manager`. Não criar
  capability nova para não deixar um spec-stub de panes.
- **D-09 — Validação real por fase:** typecheck e testes não encerram fase; cada
  fase MUST ser observada num Google Meet real antes de promoção.

## Capabilities

### Modified Capabilities

- `meetings`: durabilidade da gravação Craft-native, propriedade do pane em
  gravação, superfície de gravação (tempo decorrido, estado interrompido, ações),
  e captura de áudio.

## Impact

- `apps/electron/src/main/meetings/recording-service.ts`
- `apps/electron/src/main/meetings/meeting-service.ts`
- `apps/electron/src/main/handlers/meetings.ts`
- `apps/electron/src/main/browser-pane-manager.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/preload/browser-toolbar.ts`
- `apps/electron/src/renderer/browser-toolbar.tsx`
- `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`
- `apps/electron/src/renderer/lib/recording-elapsed.ts` (novo)
- `packages/shared/src/protocol/dto.ts`
- `packages/shared/src/i18n/locales/*.json`
- `packages/server-core/src/handlers/browser-pane-manager-interface.ts`

## Non-goals

- Caminho de captura Hermes (`captureMode: 'hermes'`) e qualquer item do
  `harden-meetings-vexa`.
- Expor `endReason` no DTO ou na UI — é F2 do `harden-meetings-vexa`.
- Abas dentro de um pane; o pane é uma `pageView` por janela.
- Pipeline de video-analysis, upload Deepgram e resumo por LLM.
- Refatorar os helpers `formatElapsed` de `ChatDisplay` e `TaskActionMenu`.
- Push, deploy ou release do Craft.
