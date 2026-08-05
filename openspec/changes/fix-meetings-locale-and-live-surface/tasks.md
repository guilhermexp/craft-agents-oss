# Tasks — fix-meetings-locale-and-live-surface

## F1 — Idioma persistido e hidratado no main

**must_haves:** a escolha de idioma sobrevive a restart no processo main; o
Deepgram recebe o idioma certo ou detecção automática, nunca `en` por fallback;
resumo e análise visual seguem a mesma fonte.

- [x] **1.1 Congelar o gap com testes RED**
  - files: `apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`, `apps/electron/src/main/meetings/output-language.isolated.ts`
  - note: cobrir (a) `i18n:changeLanguage` persiste via `setPersistedUiLanguage`; (b) bootstrap hidrata do disco; (c) sem preferência, o bootstrap não chama `changeLanguage`; (d) `getOutputLanguageName()` lê a preferência persistida; (e) o código Deepgram é nulo sem preferência.
  - verify: `bun test apps/electron/src/main/__tests__/i18n-bootstrap.test.ts apps/electron/src/main/meetings/output-language.isolated.ts` falha pelas capacidades ausentes
- [x] **1.2 Persistir a escolha no handler `i18n:changeLanguage`**
  - files: `apps/electron/src/main/index.ts`
  - note: gravar com `setPersistedUiLanguage` além de `i18n.changeLanguage`; validar o código antes de gravar (o getter já é defensivo na leitura).
  - verify: trocar o idioma nas Settings grava `uiLanguage` em `preferences.json`
- [x] **1.3 Hidratar o i18n do main no bootstrap**
  - files: `apps/electron/src/main/index.ts`
  - note: logo após `setupI18n()`, aplicar `getPersistedUiLanguage()` quando existir. Precisa acontecer antes de qualquer consumidor de idioma (menu nativo, meetings, preferences no prompt).
  - verify: `bun test apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`
- [x] **1.4 Derivar idioma de saída e código Deepgram da preferência persistida**
  - files: `apps/electron/src/main/meetings/output-language.ts`, `apps/electron/src/main/meetings/meeting-service.ts`
  - note: `getOutputLanguageName()` passa a ler `getPersistedUiLanguage()`; sem preferência, devolve marcador de "idioma da transcrição" em vez de `English`. `meeting-service.ts:882` passa a derivar da mesma fonte, não de `i18n.resolvedLanguage`.
  - verify: `bun test apps/electron/src/main/meetings/output-language.isolated.ts`
- [x] **1.5 Ajustar os prompts para o caso sem preferência**
  - files: `apps/electron/src/main/meetings/meeting-summary-service.ts`, `apps/electron/src/main/meetings/meeting-video-analysis-service.ts`
  - note: com preferência, mantém o texto atual ("Write the entire document in X"). Sem preferência, instrui a escrever no idioma da transcrição. Não inventar um terceiro idioma.
  - verify: `bun test apps/electron/src/main/meetings/meeting-summary-service.test.ts`
- [ ] **1.6 Gates da fase e validação em reunião real**
  - files: nenhum
  - note: gates automatizados rodados pelo orquestrador em 05/08/2026, todos verdes — `typecheck:all` limpo, `bun test apps/electron/src/main/meetings/` 75 pass, `bun test apps/electron/src/main/__tests__/i18n-bootstrap.test.ts ./apps/electron/src/main/meetings/output-language.isolated.ts` 16 pass, `openspec validate --strict` válido. Falta só a reunião real. Atenção: `bun test <path>.isolated.ts` sem `./` é filtro de nome, não path — o arquivo é silenciosamente pulado.
  - verify: `bun run typecheck:all`
  - verify: `bun test apps/electron/src/main/meetings/ apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`
  - verify: `openspec validate fix-meetings-locale-and-live-surface --strict --no-interactive`
  - verify: reunião real em português com app em pt-BR produz transcrição em português e resumo em português — PENDENTE (precisa de uma call de verdade)

## F2 — Visibilidade do pós-processamento e da prévia

**must_haves:** parar a gravação mostra fase em vez de "Finalizada"; falha do
pipeline é visível; a prévia do vídeo existe antes do fim do processamento.

- [x] **2.1 Congelar o gap com testes RED**
  - files: `apps/electron/src/main/meetings/meeting-service.test.ts`, `apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`
  - note: cobrir a fase escrita em cada etapa (preparação → transcrição → análise → concluído), a fase de falha, e a prévia disponível com o pipeline ainda rodando. A espera é dirigida pela própria escrita da fase (`watchPhaseWrites`), não por sleep. RED confirmado: 5 fail em `meeting-service.test.ts` antes da capacidade existir.
  - verify: os testes falham pelas capacidades ausentes
- [x] **2.2 Adicionar a fase de pós-processamento ao record**
  - files: `packages/shared/src/protocol/dto.ts`, `apps/electron/src/main/meetings/meeting-service.ts`
  - note: `postProcessingPhase` é campo separado do `status`, que continua `stopped` (D-04). `completeRecording` abre em `preparing`, `transcribeRecording` escreve `transcribing`, `generateAgentVideoAnalysis` é a etapa terminal (`analyzing` → `completed`/`failed`). `failed` é absorvente para a análise não apagar uma transcrição que falhou; `sanitizeRecord` rebaixa para `failed` a fase em curso lida do disco e a demoção de `recoverInterruptedTranscriptions` também resolve. `MeetingRecord` vive em `dto.ts` (re-exportado por `apps/electron/src/shared/types.ts` via `export *`), então o tipo entrou lá.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **2.3 Exibir a fase na lista e na página de reuniões**
  - files: `apps/electron/src/renderer/lib/meeting-status-label.ts`, `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `packages/shared/src/i18n/locales/*.json`
  - note: a fase em andamento vence "Finalizada" e a falha tem rótulo próprio dentro de `meetingStatusLabelKey`, que a lista (`MeetingsListPanel`) e a página já consomem — nenhuma mudança na lista foi necessária. `isMeetingPostProcessingRunning` mantém o poll em 1,5s até a fase resolver. Comentário órfão do `ProcessingPipeline` removido; o subtítulo da prévia passou a mostrar o rótulo localizado em vez do enum cru de `status`.
  - verify: `bun run lint:i18n:parity`
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts`
- [x] **2.4 Tornar a prévia disponível durante o processamento**
  - files: `apps/electron/src/renderer/lib/meeting-recording-preview.ts`, `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `apps/electron/src/main/meetings/meeting-service.ts`
  - note: medido antes de corrigir — `recording.path` entra no record em `attachRecordingTarget` (primeiro byte, `status: running`), não no fim; a key path-only ficou byte-idêntica em gravando (`bytesWritten: 0`, `partial`), selado (`11`) e remuxado (`34`), então o `<video>` nunca remonta. `getRecordingMediaUrl` versiona a URL por `partial`/`bytesWritten`/`remuxedAt` (query, que o handler `media://` ignora ao resolver o path) e o remux passou a gravar `remuxedAt` mesmo quando o tamanho não muda.
  - verify: `bun test ./apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`
- [ ] **2.5 Gates da fase e validação em reunião real**
  - files: nenhum
  - verify: `bun run typecheck:all`
  - verify: `bun run lint`
  - verify: `openspec validate fix-meetings-locale-and-live-surface --strict --no-interactive`
  - verify: parar uma gravação real mostra progresso contínuo até o resumo aparecer, e a prévia toca antes disso

## F3 — Host da call na página de Reuniões

**must_haves:** a call fica embutida na página sem sessão de chat selecionada;
sair da página devolve a janela; a mecânica de bounds é compartilhada com
`BrowserTabContent`, não duplicada; dá para perguntar ao agente sobre a reunião
hospedada.

- [ ] **3.1 Congelar o gap com testes RED**
  - files: `apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`
  - note: cobrir dock sem sessão selecionada, undock ao desmontar, e a sessão de agente recebendo o contexto da reunião hospedada.
  - verify: os testes falham pelas capacidades ausentes
- [ ] **3.2 Extrair a mecânica de embed do `BrowserTabContent`**
  - files: `apps/electron/src/renderer/components/browser/BrowserTabContent.tsx`, novo hook em `apps/electron/src/renderer/hooks/`
  - note: medição do retângulo, dedupe de rects, dock/undock e ocultação sob overlays viram um hook reutilizável. `BrowserTabContent` passa a consumi-lo sem mudança de comportamento — é refactor puro, verificado pelos testes existentes.
  - verify: `bun test apps/electron/src/renderer/components/browser/__tests__/`
- [ ] **3.3 Hospedar a call na página de Reuniões**
  - files: `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
  - note: o pedido de dock vindo da toolbar precisa chegar à página de Reuniões quando ela está ativa; hoje `AppShell.tsx:2257` descarta sem sessão. Não tornar o preview do chat global (D-06).
  - verify: `bun test apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`
- [ ] **3.4 Abrir sessão de agente sobre a reunião hospedada**
  - files: `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `apps/electron/src/renderer/components/app-shell/MeetingAskButton.tsx`
  - note: reaproveitar o `MeetingAskButton` existente em vez de criar outra superfície; ele já injeta a transcrição como contexto. Precisa funcionar com a reunião ainda ao vivo, não só depois de encerrada.
  - verify: `bun test apps/electron/src/renderer/pages/__tests__/meetings-browser-host.test.ts`
- [ ] **3.5 Gates da fase e validação em reunião real**
  - files: nenhum
  - verify: `bun run typecheck:all`
  - verify: `bun run validate:ci`
  - verify: `openspec validate fix-meetings-locale-and-live-surface --strict --no-interactive`
  - verify: entrar numa reunião real, encaixar a call na página, redimensionar a janela, perguntar ao agente e sair da página sem deixar janela órfã

## Boundary Map

- `apps/electron/src/main/index.ts` — bootstrap e handler IPC de idioma (F1)
- `apps/electron/src/main/meetings/output-language.ts` — fonte única do idioma de saída (F1)
- `apps/electron/src/main/meetings/meeting-service.ts` — fase de pós-processamento (F2)
- `apps/electron/src/renderer/lib/meeting-status-label.ts` — rótulo da fase e critério de poll (F2)
- `apps/electron/src/renderer/lib/meeting-recording-preview.ts` — URL versionada da prévia (F2)
- `apps/electron/src/renderer/pages/MeetingsPage.tsx` — fase, prévia e host (F2, F3)
- `apps/electron/src/renderer/components/browser/BrowserTabContent.tsx` — mecânica de embed compartilhada (F3)
- Fora de escopo: `packages/shared/src/hermes/**`, pipeline Hermes, `content-tabs-state.ts`
