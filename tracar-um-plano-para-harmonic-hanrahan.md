# Plano: Corrigir Todos os Problemas da Meetings Page

## Context

A feature de meetings (Google Meet integration) foi implementada como MVP mas tem 8 issues: 2 bugs (código morto, flags ignorados), pipeline de transcription incompleto, strings hardcoded, UX de stop destrutivo, polling duplicado, sem delete/archive, e sem health-check do bot Hermes. Este plano corrige tudo de uma vez, mantendo transcription Deepgram-only.

---

## Sequência de Implementação

| Ordem | Issue | Effort | Arquivos Principais |
|-------|-------|--------|---------------------|
| 1 | DTO: adicionar campos a MeetingRecord | S | `dto.ts` |
| 2 | Bug: wiring de `exportCraftGoogleSessionToHermesAuth` | S | `meeting-service.ts` |
| 3 | Bug: stop() não destruir browser em craft mode | S | `meeting-service.ts` |
| 4 | Archive/Delete | M | `meeting-service.ts`, `channels.ts`, `handlers/meetings.ts`, `MeetingsListPanel.tsx` |
| 5 | Health-check do bot Hermes | M | `meeting-service.ts` |
| 6 | i18n hardcoded strings | M | 8 locales + `MeetingsPage.tsx` + `MeetingsListPanel.tsx` |
| 7 | Polling duplicado | S | `MeetingsPage.tsx` |
| 8 | Transcription pipeline real | L | NOVO `transcription-service.ts` + `meeting-service.ts` + `handlers/meetings.ts` |
| 9 | summarizeOnEnd/followUpOnEnd | M | `meeting-service.ts` (depende de #8 ter transcript) |

---

## Detalhes por Issue

### 1. DTO: Estender MeetingRecord

**Arquivo:** `packages/shared/src/protocol/dto.ts` (linhas 72-88)

Adicionar a `MeetingRecord`:
```typescript
summarizeOnEnd?: boolean
followUpOnEnd?: boolean
isArchived?: boolean
archivedAt?: number
```

Atualizar `sanitizeRecord()` em `meeting-service.ts` pra preservar esses campos.

---

### 2. Bug: `exportCraftGoogleSessionToHermesAuth` nunca chamado

**Arquivo:** `apps/electron/src/main/meetings/meeting-service.ts`

Mudanças:
- Linha 342: mudar `'auth.json'` → `'bot-auth.json'` (alinhar com o que o script Python espera na linha 387)
- Antes de `runHermesMeetPlugin('start', ...)` na linha ~196, adicionar:
  ```typescript
  await this.exportCraftGoogleSessionToHermesAuth(payload.profileId).catch((err) => {
    mainLog.warn(`[meetings] cookie export to Hermes auth failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`)
  })
  ```

---

### 3. Bug: stop() destrói browser incondicionalmente

**Arquivo:** `apps/electron/src/main/meetings/meeting-service.ts` (linha 261)

Substituir:
```typescript
this.browserPaneManager.destroyInstance(record.browserInstanceId)
```
Por:
```typescript
if (record.captureMode === 'hermes') {
  this.browserPaneManager.destroyInstance(record.browserInstanceId)
}
// Craft mode: user keeps their browser open. refreshLiveStatuses()
// will mark the meeting stopped when/if the user closes the browser.
```

---

### 4. Archive/Delete

**Arquivos:**
- `packages/shared/src/protocol/channels.ts` — adicionar `ARCHIVE`, `UNARCHIVE`, `DELETE`
- `apps/electron/src/main/meetings/meeting-service.ts` — métodos `archive()`, `unarchive()`, `delete()`
- `apps/electron/src/main/handlers/meetings.ts` — registrar handlers + atualizar `HANDLED_CHANNELS`
- `apps/electron/src/shared/types.ts` — adicionar à ElectronAPI
- `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx` — botões na UI

Comportamento:
- `list()` filtra `isArchived` por default (adicionar param `includeArchived?: boolean`)
- `delete()` remove record + transcript + summary + recording files do disco
- UI: botão "Arquivar" em meetings paradas, "Excluir" com confirmação

---

### 5. Health-check do bot Hermes

**Arquivo:** `apps/electron/src/main/meetings/meeting-service.ts`

Adicionar:
- `private healthCheckTimers = new Map<string, NodeJS.Timeout>()`
- `startHealthCheck(state, meetingId)`: `setInterval(30_000)` que chama `runHermesMeetPlugin('status')`. Se bot reporta `exited/error/leaveReason`, atualiza record pra `'error'`.
- `stopHealthCheck(meetingId)`: limpa timer
- Chamar `startHealthCheck` ao transicionar pra `'running'` em `start()`
- Chamar `stopHealthCheck` no início de `stop()`
- Timeout de 5s no status check pra não acumular subprocessos pendurados

---

### 6. i18n: Strings Hardcoded

**Arquivos:** 8 locale JSONs + `MeetingsPage.tsx` + `MeetingsListPanel.tsx`

Novas keys (~25):
```
meetings.captureModeCraft, meetings.captureModeHermes,
meetings.configAriaLabel, meetings.configApiKeyLabel,
meetings.configApiKeyNotSet, meetings.configApiKeySaved,
meetings.configApiKeyPlaceholderExists, meetings.configApiKeyPlaceholderNew,
meetings.configProvider, meetings.configModel, meetings.configSave,
meetings.configTitle, meetings.configSaved, meetings.configLoadError,
meetings.configSaveError, meetings.craftRecordButton,
meetings.craftRecordStarted, meetings.noWorkspaceForConfig,
meetings.noWorkspaceForRecording, meetings.selectedMeetingTitle,
meetings.statusStarting, meetings.statusRunning,
meetings.statusStopped, meetings.statusError,
meetings.summaryUnavailable
```

Padrão: adicionar em `en.json` (alphabetical), traduzir pra pt-BR/es/zh-Hans/de/hu/ja/pl. Backend markdown (`createMeetingSummaryMarkdown`) migrar pra English (fica neutro em disco).

Validar: `bun run lint:i18n:parity`

---

### 7. Polling Duplicado

**Arquivos:** `MeetingsPage.tsx` (linhas 335-341)

Substituir `setInterval(5000)` por listener de `MEETINGS_CHANGED_EVENT`:
```typescript
React.useEffect(() => {
  if (!workspaceId || !selectedMeetingId) { ... return }
  void loadSelectedMeeting()
  const handleChanged = () => { void loadSelectedMeeting() }
  window.addEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
  // Fallback: reload a cada 15s caso evento não chegue
  const fallback = window.setInterval(() => { void loadSelectedMeeting() }, 15_000)
  return () => {
    cancelled = true
    window.removeEventListener(MEETINGS_CHANGED_EVENT, handleChanged)
    window.clearInterval(fallback)
  }
}, [selectedMeetingId, t, workspaceId])
```

MeetingsListPanel mantém seu polling 5s (é a autoridade da lista).

---

### 8. Transcription Pipeline Real (Deepgram-only)

**Arquivos:**
- NOVO: `apps/electron/src/main/meetings/transcription-service.ts`
- `apps/electron/src/main/meetings/meeting-service.ts` — método `transcribeRecording()`
- `apps/electron/src/main/meetings/recording-service.ts` — adicionar `meetingId` a `PrepareRecordingInput` e `FinalizeRecordingResult`
- `apps/electron/src/main/handlers/meetings.ts` — trigger pós-finalize

**TranscriptionService:**
```typescript
export class TranscriptionService {
  async transcribe(input: {
    audioPath: string
    provider: MeetingTranscriptionProvider
    model: string
    apiKey: string
  }): Promise<{ segments: MeetingTranscriptSegment[]; raw: unknown }>
}
```

Implementação:
- **Deepgram:** `POST https://api.deepgram.com/v1/listen?model=${model}&punctuate=true&diarize=true&utterances=true` — body: raw bytes do .webm, header `Authorization: Token ${apiKey}`, `Content-Type: audio/webm`. Parse `results.utterances[]` → segments.
- Outros providers, incluindo Groq, devem ser rejeitados explicitamente neste fluxo de Meetings.

Usar `fetch` nativo (Bun + Electron main process suportam).

**Wiring pós-finalize:**
- `RecordingService.prepare()` recebe `meetingId` opcional
- `FinalizeRecordingResult` inclui `meetingId` e `workspaceRootPath`
- Em `handlers/meetings.ts`, após finalize retornar, trigger:
  ```typescript
  void meetingService!.transcribeRecording(workspaceRoot, meetingId, result.outputPath).catch(...)
  ```

**MeetingService.transcribeRecording():**
1. Busca record → extrai provider/model
2. Busca API key via credential manager
3. Se sem key → marca transcript como `'unavailable'`
4. Chama `TranscriptionService.transcribe()`
5. Constroi `MeetingTranscriptResult` com status `'ready'` e segments reais
6. Persiste via `persistTranscript()`

---

### 9. summarizeOnEnd / followUpOnEnd

**Arquivo:** `apps/electron/src/main/meetings/meeting-service.ts`

Em `stop()`, após atualizar status pra `'stopped'`:
```typescript
if (record.summarizeOnEnd || record.followUpOnEnd) {
  void this.runPostMeetingProcessing(state, id, record).catch(...)
}
```

`runPostMeetingProcessing()`:
1. Carrega transcript do record
2. Se vazio/placeholder, skip
3. Usa `runHermesMeetPlugin` com novo command `'summarize'`:
   - Payload: `{ transcript_text, summarize: true, follow_up: record.followUpOnEnd }`
   - Python side: usa LLM (via Hermes) pra gerar summary markdown
4. Atualiza `summaryMarkdown` do record com resultado

**Fallback se Hermes indisponível:** Log warning, manter placeholder. Não bloquear stop.

---

## Verificação

```bash
# Typecheck
bun run typecheck:all

# Tests
bun test apps/electron/src/main/meetings/meeting-service.test.ts
bun test apps/electron/src/transport/__tests__/channel-map-parity.test.ts

# i18n parity
bun run lint:i18n:parity

# Full validation
bun run validate:dev
```

Manual: `bun run electron:dev` → testar fluxo completo:
1. Entrar numa meeting → detectar URL → convidar Hermes
2. Gravar no Craft → parar → verificar .webm gerado
3. Verificar transcription aparece (com API key configurada)
4. Arquivar/deletar meeting
5. Trocar locale e verificar sem strings pt-BR

---

## Riscos

| Risco | Mitigação |
|-------|-----------|
| Provider diferente de Deepgram aparece no input | Rejeitar explicitamente; Meetings é Deepgram-only |
| Hermes runtime não disponível (dev mode) | Health-check e summarization gracefully skip |
| auth.json → bot-auth.json pode quebrar setup existente | Log warning se arquivo antigo existe |
| Channel parity test | Manter HANDLED_CHANNELS sincronizado com channels.ts |
| 8 locales × 25 keys = 200 entries | Mecânico mas volumoso; usar translate pra non-pt-BR |
