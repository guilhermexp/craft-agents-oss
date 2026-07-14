## 1. F3.1 — Recovery de transcrições presas em "capturing"

- [x] 1.1 `MeetingService.recoverInterruptedTranscriptions(workspaceId, workspaceRootPath)`: transcript `capturing` + áudio no disco + provider/model → re-dispara `transcribeRecording`; senão rebaixa para `unavailable` com mensagem acionável
- [x] 1.2 `registerMeetingHandlers` roda o recovery uma vez no boot para todos os workspaces (`getWorkspaces()`), fire-and-forget com log de erro
- [x] 1.3 Teste: fixture persistida com transcript `capturing` + áudio presente → recovery re-transcreve (status sai de `capturing` para `ready`); áudio ausente → `unavailable`; key ausente → `unavailable`

## 2. F3.2 — ffmpeg órfão após timeout do python

- [x] 2.1 `video_evidence.py`: `run()` ganha `timeout` (o `subprocess.run` mata o ffmpeg); timeout em best-effort (`check=False`) vira falha do passo, não aborto do pipeline
- [x] 2.2 Budgets internos abaixo dos 180s do TS (contact sheet/audio 120s, probe/frame 30s) para o python aplicar o timeout antes de ser morto
- [x] 2.3 Verificação: wrapper com comando lento + timeout não deixa processo neto vivo (verificação documentada via execução direta)

## 3. F3.3 — abort() apaga parcial e fecha o meeting

- [x] 3.1 `RecordingService.abort()` apaga o `.webm` parcial best-effort após fechar o stream e devolve `{ meetingId, workspaceId }`
- [x] 3.2 Handler `RECORDING_ABORT` fecha o meeting record associado via `meetingService.stop(...)` best-effort
- [x] 3.3 Comentário do renderer (`browser-toolbar.tsx`) ajustado para o comportamento real
- [x] 3.4 Teste: abort remove o arquivo parcial, devolve os ids para o handler e é idempotente

## 4. F3.4 — Deepgram sem gravação inteira em RAM

- [x] 4.1 Body do fetch vira stream de arquivo (`Readable.toWeb(createReadStream(...))` + `duplex:'half'`); tamanho logado via `stat`
- [x] 4.2 `fetch` com `AbortSignal.timeout(...)` explícito; tratamento de erro existente preservado
- [x] 4.3 Teste (isolado): fetch recebe `AbortSignal` e o body é `ReadableStream`, não Buffer

## 5. Validação

- [x] 5.1 `HOME=/tmp/craft-worker-home bun run validate:ci` → exit 0
- [x] 5.2 Baseline meetings (meeting-service.test.ts + meeting-summary-service.test.ts = 13 pass) sem regressão
- [x] 5.3 `openspec validate fix-meetings-recovery-cleanup --strict --no-interactive` → verde
