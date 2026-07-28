# Tasks — harden-meetings-vexa

## F1 — Lifecycle durável e isolamento de testes

**must_haves:** todo encerramento Hermes converge numa finalização idempotente;
transcript incremental sobrevive a crash; quit é bounded; a suíte não escreve
no config real do usuário.

- [x] **1.1 Congelar os gaps de finalização com testes RED**
  - files: `apps/electron/src/main/meetings/meeting-service.test.ts`
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **1.2 Implementar finalização única e persistência incremental**
  - files: `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/meetings/meeting-service.test.ts`
  - note: o sink é o único a escrever status terminal; a entrada in-flight é o
    mutex do bot singleton (Stop/Delete não liberam antes do seal), a intenção de
    purge do delete vive em `pendingDeletions` e é honrada por uma finalização já
    em voo (purga exatamente uma vez, e nunca sobre um seal falho), terminal/free
    exige evidência do bot tanto no `status` quanto no `stop`
    (`ok:true` ou `reason: 'no active meeting'`), seal falho rearma health check +
    poll, o resumo opcional roda fora da janela in-flight, e toda mutação de
    record (`updateRecord`, `purgeMeeting`) reverte a memória quando a escrita do
    store falha, para que disco e memória nunca divirjam num retry.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **1.3 Integrar shutdown bounded com transcript já persistido**
  - files: `apps/electron/src/main/index.ts`, `apps/electron/src/main/meetings/meeting-service.ts`, `apps/electron/src/main/meetings/meeting-service.test.ts`
  - note: `shutdown()` reporta `failed` quando o seal falha, e `app:relaunch`
    aguarda `relaunchAfterSealingCaptures()` porque `app.exit(0)` não emite
    `before-quit`.
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [x] **1.4 Isolar o config root dos testes na origem**
  - files: `packages/shared/src/workspaces/storage.ts`, `packages/shared/src/workspaces/__tests__/storage-meetings.test.ts`, testes de meetings que criavam `craft-meetings-*`
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts apps/electron/src/main/meetings/recording-service.test.ts`
- [ ] **1.5 Rodar gates da fase e validar uma reunião real**
  - files: nenhum arquivo novo esperado além de evidência local não commitada
  - verify: `bun run typecheck:all`
  - verify: `openspec validate harden-meetings-vexa --strict --no-interactive`
  - verify: Google Meet real: pane close, quit e encerramento remoto preservam transcript e deixam status terminal

## F2 — Join e encerramento autônomo

**must_haves:** locale fixo e args seguros; outcomes tipados visíveis; reunião
sem interação alcança estado terminal; patches Hermes são a fonte autorada.

- [ ] **2.1 Escrever testes RED de args, outcomes e reconciliação**
  - files: testes focados do plugin/meetings e `apps/electron/src/main/meetings/meeting-service.test.ts`
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [ ] **2.2 Fixar locale e safe browser args no overlay Hermes**
  - files: `apps/electron/scripts/hermes-patches/**`, testes focados do plugin
  - verify: patch aplica sobre o SHA pinado e args incluem locale sem deny-list
- [ ] **2.3 Propagar admission/removal outcomes tipados até a UI**
  - files: overlay Hermes, `apps/electron/src/main/meetings/meeting-service.ts`, `packages/shared/src/protocol/dto.ts`, `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx`
  - verify: `bun run typecheck:all`
- [ ] **2.4 Adicionar reconciliação periódica e duração máxima**
  - files: `apps/electron/src/main/meetings/meeting-service.ts`, testes focados
  - verify: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
- [ ] **2.5 Rebuild Hermes, gates e validação real de join/exit**
  - files: runtime gerado não commitado
  - verify: `bun run electron:bundle:hermes`
  - verify: `openspec validate harden-meetings-vexa --strict --no-interactive`
  - verify: Google Meet real em host pt-BR: join em inglês, denial distinto e call-end automático preservando transcript

## F3 — Áudio per-participant, STT e transcript estável

**must_haves:** áudio 16 kHz por canal com attribution Apache-2.0; naming nunca
chuta speaker; captions continuam fallback; Deepgram continua default; draft
usa segment id estável e texto confirmado não regride.

- [ ] **3.1 Escrever testes RED da captura, naming, WAV/STT e agreement**
  - files: testes novos/focados sob plugin e `apps/electron/src/main/meetings/`
  - verify: testes focados definidos na implementação falham pela ausência das capacidades
- [ ] **3.2 Portar captura browser-side com bridge e atribuição**
  - files: `apps/electron/scripts/hermes-patches/**`, fonte do capture bundle, `THIRD_PARTY_LICENSES.md`
  - verify: testes de canais, late join, cleanup, fallback e exactly-one-lit
- [ ] **3.3 Adicionar dialeto STT OpenAI-compatible mantendo Deepgram default**
  - files: `apps/electron/src/main/meetings/transcription-service.ts`, DTO/config/settings e testes
  - verify: testes de WAV, silence gate, URL idempotente, non-2xx e regressão Deepgram
- [ ] **3.4 Implementar LocalAgreement-2 e upsert estável na UI**
  - files: novo módulo puro, `meeting-service.ts`, `MeetingsPage.tsx` e testes
  - verify: testes de common word prefix, re-segmentation, idle flush, hallucination filter e segment upsert
- [ ] **3.5 Rebuild, gates e validação real com dois participantes**
  - files: runtime/build gerados não commitados
  - verify: `bun run electron:bundle:hermes`
  - verify: `bun run typecheck:all`
  - verify: `bun run lint:i18n:parity`
  - verify: `openspec validate harden-meetings-vexa --strict --no-interactive`
  - verify: Meet real com captions off: dois canais, nomes corretos em turnos, overlap desconhecido, Deepgram e endpoint compatível, transcript sem flicker

## Boundary Map

- F1 pode tocar apenas lifecycle/shutdown/storage e testes relacionados; não
  altera Hermes vendorizado, DTO/UI ou transcrição por áudio.
- F2 pode tocar join/exit, DTO e badge da lista; não inicia captura PCM nem muda
  provider STT.
- F3 pode tocar captura, STT e UI de transcript; não provisiona infraestrutura.
- O diretório `apps/electron/resources/vendor/hermes/` é output gerado; a fonte
  durável da mudança MUST ficar em `apps/electron/scripts/hermes-patches/`.
- Cada fase depende do audit e da validação real da fase anterior.

