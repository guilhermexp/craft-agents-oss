## Why

A auditoria de 2026-07-14 (fase F3) encontrou 4 problemas de recovery/cleanup no
pipeline de meetings (gravação → ffmpeg → transcrição Deepgram → video-analysis
→ resumo):

1. **F3.1 (alta)** — `completeRecording` persiste o transcript com
   `status:'capturing'` e dispara `transcribeRecording` fire-and-forget. Se o
   app crasha/fecha antes de concluir, o boot seguinte (`ensureLoaded`)
   recarrega o transcript como está e nada re-dispara: a transcrição fica presa
   em "capturing" para sempre, silenciosamente.
2. **F3.2 (média-baixa)** — o timeout de 180s do `execFileAsync` em
   `meeting-video-analysis-service.ts` mata só o python; o ffmpeg neto (que em
   `extract_contact_sheet` decodifica o vídeo inteiro) fica órfão queimando CPU.
3. **F3.3 (baixa)** — `RecordingService.abort()` só remove a entrada do map e
   destrói o stream; o `.webm` parcial fica no disco e o meeting record
   associado permanece `running`. O comentário do renderer afirma que abort
   destruiria o arquivo.
4. **F3.4 (baixa)** — `TranscriptionService` lê a gravação inteira em RAM
   (`readFile` → Buffer único, ~1–2GB para 2h) e faz `fetch` para o Deepgram
   sem `AbortSignal` (upload pode pendurar indefinidamente).

## What Changes

- **F3.1** — `MeetingService` ganha `recoverInterruptedTranscriptions(workspaceId,
  workspaceRootPath)`: para cada transcript em `capturing`, se o áudio gravado
  existe no disco e o record tem provider/model → re-dispara
  `transcribeRecording` (que já rebaixa para `unavailable` com mensagem
  acionável quando a key está ausente ou a rede falha); senão → rebaixa
  imediatamente para `unavailable` com mensagem explicando a interrupção.
  `registerMeetingHandlers` roda o recovery uma vez no boot para todos os
  workspaces. Nenhum `capturing` órfão sobrevive a um boot.
- **F3.2** — `video_evidence.py` passa `timeout` interno ao `subprocess.run`
  (que mata o ffmpeg e sai limpo) em todas as invocações de ffmpeg/ffprobe, com
  budgets abaixo dos 180s do lado TS para que o python aplique o timeout antes
  de ser morto. Chamadas best-effort (`check=False`) tratam timeout como falha
  daquele passo em vez de abortar o pipeline.
- **F3.3** — `abort()` apaga o `.webm` parcial (best-effort, após fechar o
  stream) e devolve `{ meetingId, workspaceId }` para o handler fechar o
  meeting record via `stop()`. Comentário do renderer ajustado para o
  comportamento real.
- **F3.4** — o corpo do upload Deepgram vira stream de arquivo
  (`Readable.toWeb(createReadStream(...))` + `duplex:'half'`) e o `fetch` ganha
  `AbortSignal.timeout(...)` explícito. Tratamento de erro existente (catch que
  reporta `unavailable`) preservado.

## Impact

- Affected specs: `meetings`.
- Affected code:
  - `apps/electron/src/main/meetings/meeting-service.ts` (F3.1)
  - `apps/electron/src/main/handlers/meetings.ts` (F3.1, F3.3)
  - `apps/electron/resources/meeting-agent-skills/video-analysis/scripts/video_evidence.py` (F3.2)
  - `apps/electron/src/main/meetings/recording-service.ts` (F3.3)
  - `apps/electron/src/renderer/browser-toolbar.tsx` (F3.3, comentário)
  - `apps/electron/src/main/meetings/transcription-service.ts` (F3.4)
- Sem mudança de schema on-disk: `MeetingTranscriptResult.status` já inclui
  `unavailable`; recovery só transita estados existentes.
