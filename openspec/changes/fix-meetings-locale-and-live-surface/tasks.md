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
  - verify: `bun run typecheck:all`
  - verify: `bun test apps/electron/src/main/meetings/ apps/electron/src/main/__tests__/i18n-bootstrap.test.ts`
  - verify: `openspec validate fix-meetings-locale-and-live-surface --strict --no-interactive`
  - verify: reunião real em português com app em pt-BR produz transcrição em português e resumo em português

## F2 — Visibilidade do pós-processamento e da prévia

**must_haves:** parar a gravação mostra fase em vez de "Finalizada"; falha do
pipeline é visível; a prévia do vídeo existe antes do fim do processamento.

- [ ] **2.1 Congelar o gap com testes RED**
  - files: `apps/electron/src/main/meetings/meeting-service.test.ts`, `apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`
  - note: cobrir a fase escrita em cada etapa (preparação → transcrição → análise → concluído), a fase de falha, e a prévia disponível com o pipeline ainda rodando.
  - verify: os testes falham pelas capacidades ausentes
- [ ] **2.2 Adicionar a fase de pós-processamento ao record**
  - files: `apps/electron/src/shared/types.ts`, `apps/electron/src/main/meetings/meeting-service.ts`
  - note: campo separado do `status`, que continua `stopped` (D-04). Escrito por `completeRecording`, `remuxRecordingForSeek`, `transcribeRecording` e `generateAgentVideoAnalysis`; sempre resolvido em concluído ou falha, inclusive nos caminhos de erro e no `recoverInterruptedTranscriptions`.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [ ] **2.3 Exibir a fase na lista e na página de reuniões**
  - files: `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`, `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `apps/electron/src/renderer/lib/meeting-status-label.ts`, `packages/shared/src/i18n/locales/*.json`
  - note: fase em andamento prevalece sobre o rótulo "Finalizada"; falha tem estado próprio. Enquanto a fase não estiver resolvida, o polling da página não deve cair para o intervalo de 15s (`MeetingsPage.tsx:395`). Remover o comentário órfão que cita `ProcessingPipeline` (`MeetingsPage.tsx:448`).
  - verify: `bun run lint:i18n:parity`
  - verify: `bun test apps/electron/src/renderer/lib/__tests__/meeting-status-label.test.ts`
- [ ] **2.4 Tornar a prévia disponível durante o processamento**
  - files: `apps/electron/src/renderer/pages/MeetingsPage.tsx`, `apps/electron/src/main/meetings/meeting-service.ts`
  - note: investigar antes de corrigir — medir em qual momento `recording.path` chega ao renderer e se o `renameSync` do remux deixa o `<video>` preso ao inode antigo. A key do player precisa mudar quando o arquivo é substituído; hoje ela é o próprio path, que não muda.
  - verify: `bun test apps/electron/src/renderer/pages/__tests__/meetings-recording-preview.test.ts`
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
- `apps/electron/src/renderer/pages/MeetingsPage.tsx` — fase, prévia e host (F2, F3)
- `apps/electron/src/renderer/components/browser/BrowserTabContent.tsx` — mecânica de embed compartilhada (F3)
- Fora de escopo: `packages/shared/src/hermes/**`, pipeline Hermes, `content-tabs-state.ts`
