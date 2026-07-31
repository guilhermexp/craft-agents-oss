# Tasks — harden-craft-recording-capture

## F0 — Medição

**must_haves:** as duas perguntas abertas são medidas em harness Electron
descartável (não commitado); o resultado fica escrito no plano; a decisão sobre
abrir requirement P0 é tomada antes de F3.

- [x] **0.1 Medir chunks com a janela escondida (Q1) e término do track na navegação (Q2)**
  - files: harness Electron descartável, NÃO commitado (fora do git, ex.: `apps/electron/scratch/` não versionado)
  - note: rodar por `hub start` (PTY) ou fazer o harness escrever num arquivo de log — o binário Electron por `bash` engoliu o stdout. Q1 = BrowserWindow + pageView (canvas animado + oscillator) + recorder, `setDisplayMediaRequestHandler` concedendo `pageView.webContents.mainFrame`, `recorder.start(1000)`, `window.hide()` após 4s, observar 6s, `show()`; sucesso = cadência e tamanho de chunk comparáveis enquanto escondida. Q2 = `pageView.webContents.loadURL('about:blank')` e observar `track-ended`.
  - verify: log do harness mostra tamanho de chunk antes e durante o `hide` (Q1) e o evento `track-ended` após a navegação (Q2)
- [x] **0.2 Registrar o resultado da medição no plano**
  - files: `docs/superpowers/plans/2026-07-29-craft-recording-capture-hardening.md`
  - verify: a seção "F0 — Medição" do plano contém os números de Q1 e a conclusão de Q2
- [x] **0.3 Decidir se Q1 exige uma requirement P0 nova antes de F3**
  - files: `docs/superpowers/plans/2026-07-29-craft-recording-capture-hardening.md`
  - note: se Q1 falhar (sem chunks com a janela escondida), abrir requirement P0 (ex.: `backgroundThrottling: false` no toolbarView ou mover a captura para o main) em `openspec/changes/harden-craft-recording-capture/specs/meetings/spec.md` ANTES de F3; se passar, registrar que nenhuma requirement extra é necessária.
  - verify: decisão explícita registrada no plano (P0 aberta com justificativa ou dispensada)
- [x] **0.4 Rodar os gates da fase F0**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`

## F1 — Durabilidade da gravação

**must_haves:** o `.webm` é referenciado desde o primeiro byte e sobrevive ao
sweep; o parcial é marcado `partial` e limpo só por `completeRecording`; o main
sela sozinho no quit e no relaunch sem depender do renderer.

- [x] **1.1 Congelar os gaps de durabilidade com testes RED**
  - files: `apps/electron/src/main/meetings/meeting-service.test.ts`, `apps/electron/src/main/meetings/recording-service.test.ts`
  - note: cobrir `attachRecordingTarget` persiste `partial` e o parcial SOBREVIVE ao sweep num restart; `completeRecording` limpa `partial`; boot deixa o record interrompido `stopped` mantendo o arquivo; `prepare` guarda o mime; `finalize` sem mime usa o guardado; `finalizeAll` sela várias e pula a que falha; `finalizeForInstance` filtra por instância.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts apps/electron/src/main/meetings/recording-service.test.ts` (falha pela ausência das capacidades)
- [x] **1.2 Adicionar `MeetingRecordingMetadata.partial` e preservá-lo no sanitizer**
  - files: `packages/shared/src/protocol/dto.ts`, `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/meetings/meeting-service.test.ts`
  - note: C1 — `sanitizeRecord` MUST preservar `partial` no ramo `recording` (ler o sanitizer antes de editar); após `completeRecording`, `recording.partial` MUST ser falsy.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **1.3 Implementar `attachRecordingTarget` e chamá-lo no prepare**
  - files: `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/handlers/meetings.ts`, `apps/electron/src/main/meetings/meeting-service.test.ts`
  - note: C2 — persiste via `updateRecord` `recording: { path, mimeType, bytesWritten: 0, durationMs: 0, partial: true }`; NÃO muda `status` (segue `running`); NÃO dispara transcrição/summary; chamado em `RECORDING_PREPARE` logo após `recordingService.prepare`. Referência desde o primeiro byte faz `reconcileOrphanRecordings` preservar o parcial.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **1.4 Propagar `mimeType` pelo prepare (renderer, preload, handler, service)**
  - files: `apps/electron/src/main/meetings/recording-service.ts`, `apps/electron/src/preload/browser-toolbar.ts`, `apps/electron/src/main/handlers/meetings.ts`, `apps/electron/src/renderer/browser-toolbar.tsx`, `apps/electron/src/main/meetings/recording-service.test.ts`
  - note: C3 — `PrepareRecordingInput`, `ActiveRecording` e `FinalizeRecordingResult` ganham `mimeType: string`; `FinalizeRecordingResult` ganha também `browserInstanceId: string` e `abort` passa a devolver `{ meetingId?, workspaceId, browserInstanceId }`, porque limpar o `captureLock` (C6/F2) exige o pane dono; `finalize(recordingId, mimeType?)` usa o guardado quando omitido; preload `prepareRecording({ urlOrCode, workspaceId?, mimeType })`; a toolbar move a escolha do mime (`:300-301`) para ANTES de `api.prepareRecording` (`:291`) e passa no payload.
  - verify: `bun test apps/electron/src/main/meetings/recording-service.test.ts`
- [x] **1.5 Implementar `finalizeAll` e `finalizeForInstance`**
  - files: `apps/electron/src/main/meetings/recording-service.ts`, `apps/electron/src/main/meetings/recording-service.test.ts`
  - note: C4 — erro de uma gravação é logado e pulado (uma stream ruim não bloqueia as outras); ambos reusam `finalize` internamente e a segunda chamada lança `recording not found`, tolerado pelo chamador.
  - verify: `bun test apps/electron/src/main/meetings/recording-service.test.ts`
- [x] **1.6 Extrair `sealRecording` e ligar `shutdownCraftRecordings` ao before-quit e ao app:relaunch**
  - files: `apps/electron/src/main/handlers/meetings.ts`, `apps/electron/src/main/index.ts`
  - note: C5 — `sealRecording` extraído do bloco inline de `RECORDING_FINALIZE` (`:133-142`); `shutdownCraftRecordings()` = `finalizeAll()` + `sealRecording` de cada, `'idle'` sem gravação; chamado ANTES de `shutdownMeetingCaptures()` no bloco bounded (`index.ts:1144-1148`) e aguardado antes de `relaunchAfterSealingCaptures` em `app:relaunch` (`index.ts:875`). Limitação aceita: perde no máximo o último timeslice (~1s).
  - verify: `bun run typecheck:all`
  - verify: `shutdownCraftRecordings()` retorna `'idle'` sem gravação ativa e é aguardado antes de `shutdownMeetingCaptures()` no bloco bounded
- [x] **1.8 Deduplicar o start craft por pane e reunião**
  - files: `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/meetings/meeting-service.test.ts`
  - note: achado na inspeção do workspace do usuário: cada gravação gerava dois records (o da página, `ownsBrowserInstance`, sem `.webm`, e o da toolbar, com `.webm`) porque `start` nunca deduplicava. Agora, com `browserInstanceId` informado e record craft vivo (`starting`/`running`) para o mesmo código no mesmo pane, `start` devolve o existente — o record da página passa a receber a gravação via `attachRecordingTarget`.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [ ] **1.7 Rodar os gates da fase F1 e validar em call real**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts apps/electron/src/main/meetings/recording-service.test.ts`
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`
  - verify: Google Meet real: quit/crash mid-recording preserva o `.webm` e o record aparece "Interrompida" no boot seguinte

## F2 — Propriedade do pane em gravação

**must_haves:** um pane em gravação nunca é adotado por sessão de agente; o
`captureLock` é observável no DTO; destruir/trocar o profile do pane travado sela
a gravação antes de perder a stream.

- [x] **2.1 Congelar a adoção do pane travado com testes RED**
  - files: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: pane travado não é adotado; bound travado é desvinculado e uma janela nova é criada; `captureLock` aparece em `toInfo`/`toSnapshot`; o release hook dispara no destroy. Teste vigente do comportamento atual em `:541`.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts` (falha pela ausência do `captureLock`)
- [x] **2.2 Adicionar `BrowserPaneCaptureLock` com `setCaptureLock`/`getCaptureLock` e init**
  - files: `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: C6 — `interface BrowserPaneCaptureLock { reason: 'meeting-recording'; since: number }`; `BrowserInstance.captureLock` init `null` no bloco `:511-533`; `setCaptureLock` seta + `emitStateChange(instance)` + `toolbarHost.pushState(instance)`; `getCaptureLock` lê.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] **2.3 Excluir panes travados da adoção e desvincular o bound travado**
  - files: `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: C6 — `findReusableUnboundInstance` (`:1596-1599`) ganha `&& !i.captureLock`; `createForSession` (`:1607-1618`), se o `existing` tem `captureLock`, loga, desvincula (`boundSessionId = null`, `ownerType = 'manual'`, preserva `ownerSessionId`) e cai no `createInstance` (`:1641-1647`) já existente. `SessionManager` continua chamando sem `allowReuseManual`.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] **2.4 Expor `captureLock` no DTO (`toInfo`/`toSnapshot`)**
  - files: `packages/shared/src/protocol/dto.ts`, `packages/server-core/src/handlers/browser-pane-manager-interface.ts`, `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: C6 — `BrowserInstanceInfo.captureLock?: BrowserPaneCaptureLock | null` (`dto.ts:1116`) + `toInfo` (`:2137`); `BrowserInstanceSnapshot` (`browser-pane-manager-interface.ts:25`) + `toSnapshot` (`:3114`).
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] **2.5 Ligar `setCaptureReleaseHook` a `sealCraftRecordingsForInstance` e set/clear do lock**
  - files: `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/handlers/meetings.ts`, `apps/electron/src/main/index.ts`, `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: C6 — `setCaptureReleaseHook(hook)` chamado no topo de `destroyInstance` (`:633`) e em `switchProfile` (`:774`) quando a instância tem `captureLock` (fire-and-forget); o hook é `sealCraftRecordingsForInstance` (C5), registrado no `index.ts`. `RECORDING_PREPARE` seta `{ reason: 'meeting-recording', since: Date.now() }`; `RECORDING_FINALIZE` limpa com `result.browserInstanceId` e `RECORDING_ABORT` com o `browserInstanceId` devolvido pelo abort, ambos em `finally`; `shutdownCraftRecordings` limpa por instância.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] **2.6 Adicionar o guard opcional do seam (defesa em profundidade)**
  - files: `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
  - note: C6 — no seam por `ownerKey` (`:2164-2230`), `navigate` e `destroyInstance` recusam pane travado com `CodedError('BROWSER_INSTANCE_CAPTURE_LOCKED', ...)`. NÃO tocar no `navigate` público — o usuário tem de poder navegar o pane dele.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts`
- [x] **2.7 Finalizar a gravação quando o pane deixa a reunião**
  - files: `apps/electron/src/renderer/lib/meet-navigation-finalize.ts` (novo), `apps/electron/src/renderer/lib/__tests__/meet-navigation-finalize.test.ts` (novo), `apps/electron/src/renderer/browser-toolbar.tsx`
  - note: aberto pela medição da F0 (Q2): navegar o pane NÃO encerra o track — a gravação segue e o novo conteúdo entra no mesmo `.webm`, e o comentário em `browser-toolbar.tsx:326-329` está errado quanto a "navegou para fora". Decisão isolada em `shouldFinalizeOnMeetNavigation(activeRecordingMeetUrl, currentUrl)`; a toolbar chama `stopRecording('finalize')` quando o helper devolve `true` num `onStateUpdate`. O auto-finalize por `track.ended` continua cobrindo "Stop sharing" e teardown do frame.
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/meet-navigation-finalize.test.ts`
- [ ] **2.8 Rodar os gates da fase F2 e validar em call real**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-manager.test.ts apps/electron/src/renderer/lib/__tests__/meet-navigation-finalize.test.ts`
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`
  - verify: Google Meet real: agente abre uma janela nova e a call gravando não cai (pane travado não é adotado); navegar o pane para fora da reunião finaliza a gravação

## F3 — UI de gravação

**must_haves:** lógica testável de UI sai como helper puro em `renderer/lib/`; o
timer aparece na toolbar e na sidebar; ações da sidebar viram só-ícone; as chaves
i18n têm paridade nos 8 locales.

- [x] **3.1 Escrever testes RED do `formatRecordingElapsed` e do helper de label da sidebar**
  - files: `apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts` (novo), `apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts` (novo)
  - note: C8 casos exatos: `0 → "0:00"`, `9_000 → "0:09"`, `65_000 → "1:05"`, `599_000 → "9:59"`, `3_600_000 → "1:00:00"`, `3_725_000 → "1:02:05"`, `-5 → "0:00"`, `NaN → "0:00"`. C10 helper `meetingStatusLabelKey(record)`: `stopped` + `recording?.partial` → `'meetings.statusInterrupted'`.
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts` (falha pela ausência dos helpers)
- [x] **3.2 Implementar `formatRecordingElapsed`**
  - files: `apps/electron/src/renderer/lib/recording-elapsed.ts` (novo), `apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts` (novo)
  - note: C8 — `m:ss` abaixo de 1h, `h:mm:ss` a partir de 1h; negativo/NaN → `"0:00"`. NÃO duplicar os `formatElapsed` de `ChatDisplay.tsx`/`TaskActionMenu.tsx` nem refatorá-los.
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts`
- [x] **3.3 Implementar `meetingStatusLabelKey` (helper puro da sidebar)**
  - files: `apps/electron/src/renderer/lib/meeting-status-label.ts` (novo), `apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts` (novo)
  - note: C10 — decisão testável extraída como helper puro; `stopped` + `record.recording?.partial` → `'meetings.statusInterrupted'`.
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts`
- [x] **3.4 Adicionar o timer ao botão da toolbar**
  - files: `apps/electron/src/renderer/browser-toolbar.tsx`
  - note: C9 — `recordingStartedAt` = `Date.now()` após `recorder.start(1000)` (`:342`), `null` no `finally` de `stopRecording` (`:270-274`) e no ramo de erro de start (`:345-354`); `useEffect` com um único `setInterval(1000)` guardado por `recordingState === 'recording' && recordingStartedAt !== null`; label `meetings.recordStopWithElapsed` com `formatRecordingElapsed`, senão `meetings.recordStop`; `tabular-nums` em `recordingButtonClassName` (`:420-424`); não quebrar a string i18n em spans.
  - verify: `bun run typecheck:all`
- [x] **3.5 Remover o ícone do "Convidar Hermes"**
  - files: `apps/electron/src/renderer/browser-toolbar.tsx`
  - note: C11 — remover `<Sparkles className="size-3.5" />` (`:409`), remover `Sparkles` do import (`:13`), remover `gap-1.5` de `inviteButtonClassName` (`:397-399`).
  - verify: `bun run typecheck:all`
- [x] **3.6 Sidebar: timer, status "Interrompida" e ações só-ícone**
  - files: `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`
  - note: C10 — um tick por painel via `useEffect` com `setInterval(1000)` só quando `hasLive`; subtitle da row live (`:230-233`) `formatMeetingDate · getCaptureLabel · t('meetings.statusRunningWithElapsed', { elapsed })`, OMITINDO `transcriptionLabel` enquanto live; `getStatusLabel` (`:31-44`) recebe o record e usa `meetingStatusLabelKey`; botões Arquivar/Excluir (`:263-290`) viram `h-7 w-7 p-0` (sai `gap-1.5 px-2 text-xs`) com `aria-label` + `title` (`meetings.archive`/`meetings.delete`); `MeetingAskButton` mantém texto.
  - verify: `bun run typecheck:all`
- [x] **3.7 Adicionar o badge global de gravação consumindo `captureLock`**
  - files: `apps/electron/src/renderer/components/browser/BrowserTabStrip.tsx`, `apps/electron/src/renderer/components/browser/BrowserTabBadge.tsx`
  - note: EXIGE descoberta do componente do strip de browser antes de editar — confirmar por grep o consumidor de `BrowserInstanceInfo`/`captureLock` no strip antes de tocar; o badge lê `captureLock` do DTO (C6). Não editar sem localizar o componente.
  - verify: `bun run typecheck:all`
- [x] **3.8 Adicionar as chaves i18n nos 8 locales**
  - files: `packages/shared/src/i18n/locales/en.json`, `packages/shared/src/i18n/locales/de.json`, `packages/shared/src/i18n/locales/es.json`, `packages/shared/src/i18n/locales/hu.json`, `packages/shared/src/i18n/locales/ja.json`, `packages/shared/src/i18n/locales/pl.json`, `packages/shared/src/i18n/locales/pt-BR.json`, `packages/shared/src/i18n/locales/zh-Hans.json`
  - note: C7 — `meetings.recordStopWithElapsed`, `meetings.statusRunningWithElapsed`, `meetings.statusInterrupted`, `meetings.recordingNoAudio`; traduzir de verdade nos 6 além de en/pt-BR (não copiar en); `meetings.archive`/`meetings.delete` continuam em uso (viram `aria-label` + `title`), NÃO remover.
  - verify: `bun run lint:i18n:parity`
- [ ] **3.9 Rodar os gates da fase F3 e validar em call real**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/recording-elapsed.test.ts apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts`
  - verify: `bun run typecheck:all`
  - verify: `bun run lint:i18n:parity`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`
  - verify: Google Meet real: o timer conta na toolbar e na sidebar, as ações são só-ícone e o status "Interrompida" confere

## F4 — Áudio da gravação

**must_haves:** a presença da voz local é confirmada em call real antes de mixar
o mic; ausência de faixa de áudio avisa sem abortar; a mixagem do mic é
condicional e degrada para áudio de aba quando o mic falha.

- [ ] **4.1 Validar em call real se a voz local entra na gravação**
  - files: nenhum arquivo novo além de evidência local não commitada
  - note: C13 — hipótese: a voz local não entra porque a captura é áudio de aba (`browser-pane-manager.ts:2755-2776`) e o Meet não faz playback do próprio mic; nenhum `getUserMedia` existe no fluxo hoje. Confirmar antes de mixar o mic.
  - verify: Google Meet real: reproduzir a gravação e conferir se a própria voz está presente; registrar o resultado no plano
- [x] **4.2 Avisar ausência de faixa de áudio sem abortar**
  - files: `apps/electron/src/renderer/browser-toolbar.tsx`
  - note: C13 — quando `stream.getAudioTracks().length === 0`, avisar com `meetings.recordingNoAudio` via `setRecordingError` e CONTINUAR gravando (vídeo sem áudio é melhor que nada); diferente de `recordingNeedsVideo`, que aborta.
  - verify: `bun run typecheck:all`
- [x] **4.3 Mixar o mic condicionalmente (se 4.1 confirmar a ausência da voz local)**
  - files: `apps/electron/src/renderer/browser-toolbar.tsx`
  - note: C13 — após `getDisplayMedia`, também `getUserMedia({ audio: true })`, mixar num `AudioContext` com `MediaStreamAudioDestinationNode` e montar `new MediaStream([videoTrack, mixedAudioTrack])`; falha ao obter o mic NÃO aborta a gravação — degrada para áudio de aba e avisa.
  - verify: `bun run typecheck:all`
- [ ] **4.4 Rodar os gates da fase F4 e validar em call real**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`
  - verify: Google Meet real: voz local presente na gravação (ou aviso de degradação quando o mic falha, sem abortar)

## F5 — Idioma do conteúdo gerado

**must_haves:** a transcrição sai no idioma da call (Deepgram com `language` do
locale, não o default inglês); resumo e análise visual saem no idioma do app;
os documentos do detalhe no renderer seguem i18n. Aberto por um achado real:
call em português transcrita como fonética inglesa e resumo inteiro em inglês.

- [x] **5.1 Enviar o idioma do locale ao Deepgram**
  - files: `apps/electron/src/main/meetings/transcription-service.ts`, `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/meetings/output-language.ts` (novo), `apps/electron/src/main/meetings/transcription-service.isolated.ts`, `apps/electron/src/main/meetings/output-language.isolated.ts` (novo)
  - note: sem `language` o Deepgram assume inglês e fonetiza PT como EN — exatamente a transcrição sem sentido que o usuário mostrou. Locale sem código mapeado cai em `detect_language=true`.
  - verify: `bun test ./apps/electron/src/main/meetings/transcription-service.isolated.ts ./apps/electron/src/main/meetings/output-language.isolated.ts`
- [x] **5.2 Instruir resumo e análise visual no idioma do app**
  - files: `apps/electron/src/main/meetings/meeting-summary-service.ts`, `apps/electron/src/main/meetings/meeting-video-analysis-service.ts`
  - note: saída inteira no idioma ativo do app, cabeçalhos incluídos; a transcrição não arrasta o resumo para o idioma errado; fala citada pode manter o idioma original.
  - verify: `bun run typecheck:all`
- [x] **5.3 Localizar os documentos do detalhe no renderer**
  - files: `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `packages/shared/src/i18n/locales/*.json`
  - note: rótulos (Origem/Status/Link/Captura/Duração), cabeçalhos (Resumo/Transcrição) e falante padrão via chaves novas `meetings.doc*`; status reutiliza `meetingStatusLabelKey`. As 4 chaves da F3 foram restauradas após um checkout acidental.
  - verify: `bun run lint:i18n:parity`
- [ ] **5.4 Rodar os gates da fase F5 e validar em call real**
  - files: nenhum arquivo novo além de evidência local não commitada
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-craft-recording-capture --strict --no-interactive`
  - verify: Google Meet real em português: transcrição sai em português e o resumo sai em português
