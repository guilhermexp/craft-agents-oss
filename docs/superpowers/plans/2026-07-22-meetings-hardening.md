# Meetings Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar os 4 blockers e os majors da auditoria da feature Meetings (perda de dados no store, colisão de workspace, subprocesso Hermes sem timeout, transcrição Hermes inexistente, vazamento do bot, i18n vazando PT, defeitos de UI) mantendo o pipeline craft-mode intacto.

**Architecture:** A feature vive em `apps/electron/src/main/meetings/*` (services main-process), `apps/electron/src/main/handlers/meetings.ts` (RPC + ipcMain), `packages/shared/src/workspaces/storage.ts` (paths de storage JSON por workspace) e renderer (`MeetingsPage.tsx`, `MeetingsListPanel.tsx`, `browser-toolbar.tsx`). Storage é JSON com escrita atômica (`meetings.json` + `transcripts/<id>.json` + `summaries/<id>.md` + `recordings/<id>.webm`) sob `~/.craft-agent/workspaces/<slug>/meetings/`. O bot do Google Meet é um singleton do plugin Hermes (`plugins/google_meet/process_manager.py`) invocado via `python -c` (`runHermesMeetPlugin`).

**Tech Stack:** Electron + Bun + TypeScript strict, bun:test, i18next (8 locales em `packages/shared/src/i18n/locales/`), Deepgram REST, Hermes (Python) via subprocess.

## Global Constraints

- `strict: true`; nunca `any`. Named exports. Zod só onde já usado.
- NUNCA criar segunda convenção ao lado de uma existente — reutilizar `atomicWriteTextFileSync`, `safeFileId`, `t()` main-process, padrão `completeRecording` para pipelines fire-and-forget.
- Hermes fica isolado do runtime nativo Claude/Pi (AGENTS.md). Nada de mexer em `packages/shared/src/agent/native/`.
- Toda string de UI/backend visível ao usuário via i18n (`t()` com chave em TODOS os 8 locales: de, en, es, hu, ja, pl, pt-BR, zh-Hans). `bun run lint:i18n:parity` deve passar.
- Testes que precisam do módulo real mockado por outros arquivos vão em `*.isolated.ts` (invocação `bun test ./caminho` própria — ver comentário em `transcription-service.isolated.ts:1-3`).
- Validação focada por task; suíte completa só na Task 10.
- Commits frequentes: 1 commit por task, mensagem `fix(meetings): …` ou `feat(meetings): …`.

## Contratos compartilhados (referência para todas as tasks)

```ts
// packages/shared/src/protocol/dto.ts (já existe — NÃO alterar)
interface MeetingTranscriptSegment { id: string; speaker?: string; text: string; startedAt?: number; endedAt?: number; timestamp: number }
interface MeetingTranscriptResult { meetingId: string; status: 'placeholder' | 'capturing' | 'ready' | 'unavailable'; transcript: MeetingTranscriptSegment[]; summaryMarkdown?: string; message?: string; updatedAt: number }
```

Retorno do plugin Hermes `transcript` (process_manager.py:219-243):
```json
{ "ok": true, "meetingId": "abc-defg-hij", "lines": ["Alice: hello", "Bob: hi"], "total": 2, "path": "…/transcript.txt" }
```

---

## Fase 0 — Blockers de dados e travamento

### Task 1: Backup de `meetings.json` corrompido (blocker: perda de dados em cascata)

**Files:**
- Modify: `apps/electron/src/main/meetings/meeting-service.ts:877-905` (`ensureLoaded`), `:918-983` (`reconcileOrphanRecordings`)
- Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

**Interfaces:**
- Consumes: `atomicWriteTextFileSync`, `mainLog`, `renameSync`/`readdirSync` (já importados de `fs`).
- Produces: comportamento — store ilegível é renomeado para `meetings.json.corrupt-<ts>` antes de qualquer write; sweep de órfãos pula quando existe backup `.corrupt-`.

- [ ] **Step 1: Escrever os testes que falham**

Em `meeting-service.test.ts`, dentro de `describe('MeetingService storage')`:

```ts
it('backs up a corrupt meetings.json instead of clobbering it', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
  tempDirs.push(workspaceRoot)
  const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
  metadataDirs.push(dirname(meetingsDir))
  mkdirSync(meetingsDir, { recursive: true })
  writeFileSync(join(meetingsDir, 'meetings.json'), '{ this is not json', 'utf8')

  const service = new MeetingService(createBrowserPaneManager())
  expect(service.list(workspaceRoot)).toEqual([])

  const backups = readdirSync(meetingsDir).filter((f) => f.startsWith('meetings.json.corrupt-'))
  expect(backups).toHaveLength(1)
  expect(readFileSync(join(meetingsDir, backups[0]!), 'utf8')).toBe('{ this is not json')

  // Próximo write cria um store novo e válido sem tocar no backup.
  const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'craft', transcribe: false })
  const store = JSON.parse(readFileSync(join(meetingsDir, 'meetings.json'), 'utf8')) as { meetings: Array<{ id: string }> }
  expect(store.meetings.map((m) => m.id)).toEqual([record.id])
})

it('skips orphan recording sweep while a corrupt backup exists', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
  tempDirs.push(workspaceRoot)
  const meetingsDir = getWorkspaceMeetingsPath(workspaceRoot)
  metadataDirs.push(dirname(meetingsDir))
  const recordingsDir = join(meetingsDir, 'recordings')
  mkdirSync(recordingsDir, { recursive: true })
  writeFileSync(join(meetingsDir, 'meetings.json'), 'garbage', 'utf8')
  writeFileSync(join(recordingsDir, 'orphan.webm'), 'webm-bytes', 'utf8')

  const service = new MeetingService(createBrowserPaneManager())
  service.list(workspaceRoot)

  // O .webm sobrevive: os registros que o referenciam podem estar no backup.
  expect(existsSync(join(recordingsDir, 'orphan.webm'))).toBe(true)
})
```

Imports adicionais no topo do teste (se ausentes): `readFileSync`, `readdirSync`, `writeFileSync` de `node:fs`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts -t 'corrupt'`
Expected: FAIL (nenhum backup criado; orphan.webm deletado).

- [ ] **Step 3: Implementar em `ensureLoaded`**

Substituir o bloco `catch` atual (`meeting-service.ts:896-904`):

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  mainLog.error(`[meetings] failed to load persisted meetings from ${state.storePath}: ${message}`)
  state.corruptDetected = true
  const backupPath = `${state.storePath}.corrupt-${Date.now()}`
  try {
    renameSync(state.storePath, backupPath)
    mainLog.warn(`[meetings] unreadable meetings store moved to ${backupPath}; continuing with an empty store`)
    state.loaded = true
  } catch (renameError) {
    // Sem backup garantido, escrever destruiria a única cópia dos dados —
    // falhe alto em vez de deixar o próximo persist() sobrescrever.
    throw new Error(
      `Meetings store at ${state.storePath} is unreadable and could not be backed up: ${message} ` +
      `(backup failed: ${renameError instanceof Error ? renameError.message : String(renameError)})`,
    )
  }
}
```

O campo `corruptDetected` continua existindo, agora só como flag informativa do boot corrente.

- [ ] **Step 4: Implementar guard no sweep de órfãos**

No início de `reconcileOrphanRecordings` (`meeting-service.ts:918`), após computar `meetingsDir`:

```ts
let corruptBackupPresent = false
try {
  corruptBackupPresent = existsSync(meetingsDir)
    && readdirSync(meetingsDir).some((entry) => entry.startsWith('meetings.json.corrupt-'))
} catch { /* dir ilegível: trate como presente para não varrer */ corruptBackupPresent = true }
if (corruptBackupPresent) {
  mainLog.warn(`[meetings] corrupt store backup present in ${meetingsDir}; skipping orphan sweep until it is resolved`)
  return
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts`
Expected: PASS (suite inteira, incluindo os 2 novos).

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/meetings/meeting-service.ts apps/electron/src/main/meetings/meeting-service.test.ts
git commit -m "fix(meetings): back up corrupt meetings.json and skip orphan sweep instead of clobbering data"
```

---

### Task 2: Storage keyed por workspace id + migração (blocker: colisão por basename)

**Files:**
- Modify: `packages/shared/src/workspaces/storage.ts:96-99` (`getWorkspaceMeetingsPath`), `:372-379` (`deleteWorkspaceFolder`)
- Test: `packages/shared/src/workspaces/__tests__/storage-meetings.test.ts`

**Interfaces:**
- Consumes: `loadWorkspaceConfig(rootPath)` (mesmo arquivo, `storage.ts:109`), `extractWorkspaceSlugFromPath`, `CONFIG_DIR`.
- Produces: `getWorkspaceMeetingsPath(rootPath: string): string` (assinatura INALTERADA — todos os callers continuam funcionando) agora resolve `CONFIG_DIR/workspaces/<config.id ?? basename>/meetings` e migra o diretório legado uma única vez.

- [ ] **Step 1: Escrever os testes que falham**

Em `storage-meetings.test.ts`:

```ts
it('keys meetings storage by workspace config id, not rootPath basename', () => {
  const parentA = mkdtempSync(join(tmpdir(), 'craft-ws-a-'))
  const parentB = mkdtempSync(join(tmpdir(), 'craft-ws-b-'))
  tempDirs.push(parentA, parentB)
  const rootA = join(parentA, 'work')
  const rootB = join(parentB, 'work') // mesmo basename, workspaces distintos
  createWorkspaceAtPath(rootA, 'Work A')
  createWorkspaceAtPath(rootB, 'Work B')
  metadataDirs.push(dirname(getWorkspaceMeetingsPath(rootA)), dirname(getWorkspaceMeetingsPath(rootB)))

  expect(getWorkspaceMeetingsPath(rootA)).not.toBe(getWorkspaceMeetingsPath(rootB))
})

it('migrates a legacy basename-keyed meetings dir and rewrites recording paths', () => {
  const parent = mkdtempSync(join(tmpdir(), 'craft-ws-mig-'))
  tempDirs.push(parent)
  const root = join(parent, 'legacy-ws')
  createWorkspaceAtPath(root, 'Legacy WS')
  const config = loadWorkspaceConfig(root)!

  // Simula o layout antigo: dir keyed por basename com um recording referenciado.
  const legacyDir = join(homedir(), '.craft-agent', 'workspaces', 'legacy-ws', 'meetings')
  const newDir = join(homedir(), '.craft-agent', 'workspaces', config.id, 'meetings')
  metadataDirs.push(dirname(legacyDir), dirname(newDir))
  rmSync(newDir, { recursive: true, force: true })
  mkdirSync(join(legacyDir, 'recordings'), { recursive: true })
  const legacyWebm = join(legacyDir, 'recordings', 'm1.webm')
  writeFileSync(legacyWebm, 'x', 'utf8')
  writeFileSync(join(legacyDir, 'meetings.json'), JSON.stringify({
    version: 1,
    meetings: [{ id: 'm1', provider: 'google-meet', status: 'stopped', url: 'https://meet.google.com/abc-defg-hij', browserInstanceId: 'b1', startedAt: 1, updatedAt: 1, recording: { path: legacyWebm, bytesWritten: 1, durationMs: 1 } }],
  }), 'utf8')

  const resolved = getWorkspaceMeetingsPath(root)

  expect(resolved).toBe(newDir)
  expect(existsSync(join(newDir, 'meetings.json'))).toBe(true)
  expect(existsSync(legacyDir)).toBe(false)
  const store = JSON.parse(readFileSync(join(newDir, 'meetings.json'), 'utf8')) as { meetings: Array<{ recording?: { path: string } }> }
  expect(store.meetings[0]!.recording!.path).toBe(join(newDir, 'recordings', 'm1.webm'))
})
```

Nota: se `createWorkspaceAtPath` gerar `config.id` igual ao basename, o teste de migração precisa forçar divergência — após criar, edite `config.json` do workspace (`saveWorkspaceConfig(root, { ...config, id: 'legacy-ws-stable-id' })`) e use esse id no `newDir`. Verifique o comportamento real de `createWorkspaceAtPath` antes (leia `storage.ts:330-360`).

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/shared/src/workspaces/__tests__/storage-meetings.test.ts`
Expected: FAIL (paths iguais; migração inexistente).

- [ ] **Step 3: Implementar**

Substituir `getWorkspaceMeetingsPath` (`storage.ts:96-99`):

```ts
export function getWorkspaceMeetingsPath(rootPath: string): string {
  const fallbackSlug = extractWorkspaceSlugFromPath(rootPath, 'workspace');
  const config = loadWorkspaceConfig(rootPath);
  const slug = config?.id || fallbackSlug;
  const dir = join(CONFIG_DIR, 'workspaces', slug, 'meetings');
  if (config?.id && config.id !== fallbackSlug) {
    migrateLegacyMeetingsDir(join(CONFIG_DIR, 'workspaces', fallbackSlug, 'meetings'), dir);
  }
  return dir;
}

/**
 * Storage de meetings era keyed pelo basename do rootPath, o que colide entre
 * workspaces com pastas de mesmo nome. Migra o dir legado para o dir keyed por
 * id e reescreve os `recording.path` absolutos persistidos em meetings.json.
 * Best-effort e idempotente: só roda quando o destino não existe e o legado
 * tem um meetings.json.
 */
function migrateLegacyMeetingsDir(legacyDir: string, dir: string): void {
  try {
    if (existsSync(dir) || !existsSync(join(legacyDir, 'meetings.json'))) return;
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(legacyDir, dir);
    const storePath = join(dir, 'meetings.json');
    const raw = readFileSync(storePath, 'utf8');
    const store = JSON.parse(raw) as { meetings?: Array<{ recording?: { path?: string } }> };
    let changed = false;
    for (const meeting of store.meetings ?? []) {
      const p = meeting.recording?.path;
      if (typeof p === 'string' && p.startsWith(legacyDir)) {
        meeting.recording!.path = join(dir, p.slice(legacyDir.length).replace(/^[\\/]/, ''));
        changed = true;
      }
    }
    if (changed) writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // Falha de migração não pode derrubar a resolução de path; o dir legado
    // permanece e a próxima chamada tenta de novo.
  }
}
```

Conferir imports no topo de `storage.ts`: `renameSync`, `readFileSync`, `writeFileSync`, `dirname` (adicionar os ausentes de `node:fs`/`node:path`).

- [ ] **Step 4: Limpar meetings ao deletar workspace**

Em `deleteWorkspaceFolder` (`storage.ts:372-379`), antes de remover o rootPath:

```ts
try {
  rmSync(getWorkspaceMeetingsPath(rootPath), { recursive: true, force: true });
} catch { /* best-effort */ }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test packages/shared/src/workspaces/__tests__/storage-meetings.test.ts apps/electron/src/main/meetings/meeting-service.test.ts packages/shared/src/main/... 2>/dev/null; bun test packages/shared/src/workspaces/ apps/electron/src/main/meetings/meeting-service.test.ts`
Expected: PASS. Atenção: o teste existente `storage-meetings.test.ts:27-29` asserta o path por basename — atualizá-lo para o id do config criado (`loadWorkspaceConfig(workspaceRoot)!.id`).

- [ ] **Step 6: Typecheck e commit**

```bash
bun run typecheck:shared && bun run typecheck:electron
git add packages/shared/src/workspaces/storage.ts packages/shared/src/workspaces/__tests__/storage-meetings.test.ts
git commit -m "fix(meetings): key meetings storage by workspace id with legacy-dir migration"
```

---

### Task 3: Timeouts default no subprocesso Hermes (blocker: START pendurado)

**Files:**
- Modify: `apps/electron/src/main/meetings/meeting-service.ts:735-814` (`runHermesMeetPlugin`)
- Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

**Interfaces:**
- Produces: `export const HERMES_PLUGIN_TIMEOUT_MS: Record<'start' | 'status' | 'transcript' | 'stop', number>` (exportado para teste e reutilizado pela Task 4).

- [ ] **Step 1: Teste que falha**

```ts
import { HERMES_PLUGIN_TIMEOUT_MS } from './meeting-service'

describe('Hermes plugin timeouts', () => {
  it('bounds every plugin command with a positive default timeout', () => {
    for (const command of ['start', 'status', 'transcript', 'stop'] as const) {
      expect(HERMES_PLUGIN_TIMEOUT_MS[command]).toBeGreaterThan(0)
      expect(HERMES_PLUGIN_TIMEOUT_MS[command]).toBeLessThanOrEqual(60_000)
    }
  })
})
```

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts -t 'timeout'` → FAIL (export inexistente).

- [ ] **Step 2: Implementar**

Acima da classe (junto das outras consts, ~linha 38):

```ts
export const HERMES_PLUGIN_TIMEOUT_MS: Record<'start' | 'status' | 'transcript' | 'stop', number> = {
  start: 60_000,     // pm.start faz spawn+handshake do bot Playwright
  status: 10_000,
  transcript: 15_000,
  stop: 15_000,
}
```

Em `runHermesMeetPlugin`, trocar a chamada `execFileAsync` (linhas 792-802) por versão com default e captura de falha (timeout do execFile rejeita com SIGTERM):

```ts
let stdout: string
try {
  ({ stdout } = await execFileAsync(runtime.python, ['-c', script, command, JSON.stringify(payload)], {
    cwd: runtime.hermesAgentRoot,
    env: {
      ...process.env,
      HERMES_HOME: runtime.hermesHome,
      VIRTUAL_ENV: runtime.virtualEnv,
      PATH: `${runtime.vendorBinDir}:${process.env.PATH ?? ''}`,
    },
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? HERMES_PLUGIN_TIMEOUT_MS[command],
  }))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: `Hermes Meet plugin '${command}' failed or timed out: ${message}` }
}
```

Efeito em cadeia (verificar, não alterar): `start()` já lança quando `!botStart.ok` (:208-210); `waitForHermesMeetBotReady` retorna status com `error` → `start()` lança (:215-216); health-check já tem try/catch; `stop()` já engole com `.catch()`.

- [ ] **Step 3: Rodar e ver passar + commit**

```bash
bun test apps/electron/src/main/meetings/meeting-service.test.ts
git add apps/electron/src/main/meetings/meeting-service.ts apps/electron/src/main/meetings/meeting-service.test.ts
git commit -m "fix(meetings): bound every Hermes meet-plugin subprocess with a default timeout"
```

---

## Fase 1 — Modo Hermes funcional

### Task 4: Entregar transcrição do bot Hermes no stop (blocker: pipeline stub)

**Files:**
- Modify: `apps/electron/src/main/meetings/meeting-service.ts` (`stop`, novo `finalizeHermesCapture`), `apps/electron/src/main/handlers/meetings.ts:161-170,223-234` (assinatura do stop)
- Modify: `packages/shared/src/i18n/locales/*.json` (reword `meetings.placeholderHermesMessage`; novas chaves na tabela da Task 6)
- Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

**Interfaces:**
- Consumes: `runHermesMeetPlugin('transcript')` → `{ ok, lines: string[], total }`; `HERMES_PLUGIN_TIMEOUT_MS` (Task 3); `generateAgentSummary` (privado existente, :625-654).
- Produces: **breaking interno** — `MeetingService.stop(workspaceId: string, workspaceRootPath: string, id: string): MeetingRecord` (novo primeiro parâmetro, espelhando `completeRecording`). Callers a atualizar: `handlers/meetings.ts:165` (RECORDING_ABORT), `:229` (RPC STOP) e todos os `service.stop(...)` em `meeting-service.test.ts`.

- [ ] **Step 1: Teste que falha**

```ts
type PluginCommand = 'start' | 'status' | 'transcript' | 'stop'
function installHermesPluginMock(service: InstanceType<typeof MeetingService>, calls: PluginCommand[]): void {
  ;(service as unknown as { runHermesMeetPlugin: (command: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
    async (command: PluginCommand) => {
      calls.push(command)
      if (command === 'status') return { ok: true, alive: true, inCall: true }
      if (command === 'transcript') return { ok: true, lines: ['Alice: hello world', 'Bob: hi'], total: 2 }
      return { ok: true, pid: 123 }
    }
}

describe('Hermes capture transcript delivery', () => {
  it('fetches the bot transcript before stopping and persists it as ready', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(record.status).toBe('running')

    service.stop('ws-1', workspaceRoot, record.id)

    // finalizeHermesCapture é fire-and-forget: aguardar o transcript assentar.
    const deadline = Date.now() + 2_000
    let transcript = service.transcript(workspaceRoot, record.id)
    while (transcript.status !== 'ready' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      transcript = service.transcript(workspaceRoot, record.id)
    }
    expect(transcript.status).toBe('ready')
    expect(transcript.transcript.map((s) => s.text)).toEqual(['Alice: hello world', 'Bob: hi'])
    expect(transcript.transcript[0]!.speaker).toBe('Alice')
    // transcript buscado ANTES do stop (stop limpa o ponteiro ativo do plugin).
    expect(calls.indexOf('transcript')).toBeLessThan(calls.lastIndexOf('stop'))
  })

  it('demotes to unavailable when the bot has no transcript lines', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    ;(service as unknown as { runHermesMeetPlugin: (c: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
      async (c: PluginCommand) => (c === 'status' ? { ok: true, inCall: true } : c === 'transcript' ? { ok: true, lines: [], total: 0 } : { ok: true })

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.stop('ws-1', workspaceRoot, record.id)
    const deadline = Date.now() + 2_000
    let transcript = service.transcript(workspaceRoot, record.id)
    while (transcript.status === 'placeholder' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      transcript = service.transcript(workspaceRoot, record.id)
    }
    expect(transcript.status).toBe('unavailable')
  })
})
```

Ajustar TODOS os `service.stop(workspaceRoot, id)` existentes no arquivo para `service.stop('ws-test', workspaceRoot, id)`.

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts -t 'Hermes capture'` → FAIL.

- [ ] **Step 2: Implementar `finalizeHermesCapture`**

Novo método privado (colocar após `transcribeRecording`):

```ts
/**
 * Pós-processamento de reuniões capturadas pelo bot Hermes: busca o transcript
 * do plugin ANTES de encerrar o bot (stop limpa o ponteiro ativo), persiste o
 * resultado e dispara o summary quando summarizeOnEnd/followUpOnEnd estão setados.
 * Fire-and-forget a partir de stop(), espelhando completeRecording (craft mode).
 */
private async finalizeHermesCapture(workspaceId: string, workspaceRootPath: string, meetingId: string): Promise<void> {
  const state = this.getWorkspaceState(workspaceRootPath)
  const record = state.records.get(meetingId)
  if (!record || record.captureMode === 'craft') return

  let lines: string[] = []
  try {
    const res = await this.runHermesMeetPlugin('transcript')
    const rawLines = (res as { lines?: unknown }).lines
    if (res.ok && Array.isArray(rawLines)) {
      lines = rawLines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    }
  } catch { /* best-effort: segue para o stop mesmo sem transcript */ }

  void this.runHermesMeetPlugin('stop').catch(() => undefined)

  const now = Date.now()
  const segments: MeetingTranscriptSegment[] = lines.map((line, index) => {
    const match = /^([^:]{1,60}):\s+(.*)$/.exec(line)
    return {
      id: `${meetingId}-${index}`,
      speaker: match?.[1],
      text: match?.[2] ?? line,
      timestamp: now,
    }
  })

  const current = state.records.get(meetingId)
  if (!current) return
  const message = segments.length > 0
    ? t('meetings.transcriptCompletedMessage', { count: segments.length })
    : t('meetings.hermesTranscriptEmptyMessage')
  const summaryMarkdown = createMeetingSummaryMarkdown({
    title: current.title,
    url: current.url,
    captureMode: 'hermes',
    transcriptionProvider: current.transcriptionProvider,
    transcriptionModel: current.transcriptionModel,
    status: 'stopped',
    startedAt: current.startedAt,
    endedAt: current.endedAt,
    summaryBody: message,
  })
  const transcript: MeetingTranscriptResult = {
    meetingId,
    status: segments.length > 0 ? 'ready' : 'unavailable',
    transcript: segments,
    summaryMarkdown,
    message,
    updatedAt: Date.now(),
  }
  state.transcripts.set(meetingId, transcript)
  this.persistTranscript(state, transcript)
  this.updateRecord(state, meetingId, { summaryMarkdown })

  if ((current.summarizeOnEnd || current.followUpOnEnd) && segments.length > 0) {
    await this.generateAgentSummary(workspaceId, workspaceRootPath, meetingId, segments)
  }
}
```

- [ ] **Step 3: Rewire `stop()`**

Nova assinatura `stop(workspaceId: string, workspaceRootPath: string, id: string): MeetingRecord`. No corpo (:277-283), substituir o bloco de stop do bot:

```ts
if (record.captureMode !== 'craft') {
  void this.finalizeHermesCapture(workspaceId, workspaceRootPath, id).catch((err) => {
    mainLog.error(`[meetings] finalizeHermesCapture failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
  })
}
```

Remover o log "post-meeting processing deferred" (:308-310) — o processamento agora existe.

Callers em `handlers/meetings.ts`:
- `:229` → `meetingService!.stop(requireWorkspaceId(workspaceId), resolveWorkspaceRoot(workspaceId), id)` — como `resolveWorkspaceRoot` já lança para id vazio, basta `meetingService!.stop(workspaceId!, resolveWorkspaceRoot(workspaceId), id)` após o check existente.
- `:165` (RECORDING_ABORT) → `meetingService!.stop(aborted.workspaceId, resolveWorkspaceRoot(aborted.workspaceId), aborted.meetingId)`.

- [ ] **Step 4: Reword do placeholder Hermes**

Em todos os 8 locales, atualizar `meetings.placeholderHermesMessage` (texto atual admite "not implemented in this MVP") para o equivalente de: en `"The bot transcript will be imported when the meeting is stopped."` / pt-BR `"A transcrição do bot será importada quando a reunião for encerrada."`. Adicionar `meetings.hermesTranscriptEmptyMessage`: en `"The Hermes bot did not capture any transcript lines for this meeting."` / pt-BR `"O bot Hermes não capturou nenhuma linha de transcrição nesta reunião."` (traduzir nos demais locales).

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts && bun run lint:i18n:parity && bun run typecheck:electron`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/meetings/meeting-service.ts apps/electron/src/main/handlers/meetings.ts apps/electron/src/main/meetings/meeting-service.test.ts packages/shared/src/i18n/locales/
git commit -m "feat(meetings): deliver Hermes bot transcript on stop and honor summarizeOnEnd"
```

---

### Task 5: Ciclo de vida do bot — vazamentos e guard de singleton

**Files:**
- Modify: `apps/electron/src/main/meetings/meeting-service.ts` (`start`, `deleteMeeting`, `refreshLiveStatuses`, novo `findActiveHermesMeeting`)
- Test: `apps/electron/src/main/meetings/meeting-service.test.ts`

**Interfaces:**
- Consumes: mock `installHermesPluginMock` (Task 4), `browserPaneManager.destroyInstance`.
- Produces: `start()` rejeita segunda reunião Hermes simultânea com `meetings.hermesBotBusy`; nenhum caminho deixa o bot vivo sem registro dono.

- [ ] **Step 1: Testes que falham**

```ts
describe('Hermes bot lifecycle', () => {
  it('rejects a second concurrent hermes meeting', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    await expect(service.start(workspaceRoot, { urlOrCode: 'zzz-zzzz-zzz', captureMode: 'hermes' })).rejects.toThrow()
    // Nenhum segundo pm.start disparado.
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
  })

  it('stops the bot when start fails after pm.start succeeded', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    ;(service as unknown as { runHermesMeetPlugin: (c: PluginCommand) => Promise<Record<string, unknown>> }).runHermesMeetPlugin =
      async (c: PluginCommand) => {
        calls.push(c)
        // status nunca chega em inCall/lobby → start() lança "did not reach the lobby"
        if (c === 'status') return { ok: true, alive: true }
        return { ok: true, pid: 1 }
      }

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    expect(record.status).toBe('error')
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toContain('stop')
  }, 30_000)

  it('stops the bot and cleans up when a live hermes meeting is deleted', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    const record = await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes' })
    service.deleteMeeting(workspaceRoot, record.id)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toContain('stop')
  })

  it('does not start a health check for hermes meetings with transcribe:false', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-meetings-'))
    tempDirs.push(workspaceRoot)
    const service = new MeetingService(createBrowserPaneManager())
    const calls: PluginCommand[] = []
    installHermesPluginMock(service, calls)

    await service.start(workspaceRoot, { urlOrCode: 'abc-defg-hij', captureMode: 'hermes', transcribe: false })
    expect(calls).toHaveLength(0) // nem start de bot, nem status de health check
    expect((service as unknown as { healthCheckTimers: Map<string, unknown> }).healthCheckTimers.size).toBe(0)
  })
})
```

Nota sobre o 2º teste: `waitForHermesMeetBotReady` espera 20s reais (loop de 1s). Para o teste não demorar, injete timeout menor: extrair a constante `20_000` de `start()` (:211) para campo `private readonly botReadyTimeoutMs = 20_000` e sobrescrever no teste via `(service as unknown as { botReadyTimeoutMs: number }).botReadyTimeoutMs = 100` — usar `readonly` só na declaração pública; declarar como `private botReadyTimeoutMs = 20_000` (mutável) para permitir o override de teste.

Run: `bun test apps/electron/src/main/meetings/meeting-service.test.ts -t 'lifecycle'` → FAIL.

- [ ] **Step 2: Implementar guard + predicado único de bot**

Em `start()`, logo após `const payload = ...` e do cálculo de `captureMode` (:137), antes de criar pane/record:

```ts
const usesHermesBot = captureMode === 'hermes' && payload.transcribe !== false
if (usesHermesBot) {
  const active = this.findActiveHermesMeeting()
  if (active) {
    throw new Error(t('meetings.hermesBotBusy', { url: active.url }))
  }
}
```

```ts
/** O bot do plugin google_meet é um singleton por HERMES_HOME. */
private findActiveHermesMeeting(): MeetingRecord | null {
  for (const state of this.workspaceStates.values()) {
    for (const record of state.records.values()) {
      if (record.captureMode !== 'craft' && ['starting', 'running'].includes(record.status)) {
        return record
      }
    }
  }
  return null
}
```

Trocar as duas condições existentes que divergem hoje: linha 205 (`captureMode === 'hermes' && payload.transcribe !== false`) e linha 237 (`captureMode === 'hermes'`) passam ambas a usar `usesHermesBot`.

- [ ] **Step 3: Stop do bot nos caminhos de falha/limpeza**

`start()` catch (:240-247) — adicionar antes de `updateRecord`:

```ts
if (usesHermesBot && botStarted) {
  void this.runHermesMeetPlugin('stop').catch(() => undefined)
}
```

com `let botStarted = false` declarado antes do `try`, setado `true` logo após `botStart.ok` ser confirmado (:210).

`refreshLiveStatuses` (:860-875) — ao flipar um record para stopped:

```ts
if (record.captureMode !== 'craft') {
  this.stopHealthCheck(record.id)
  void this.runHermesMeetPlugin('stop').catch(() => undefined)
}
```

`deleteMeeting` (:331-351) — logo após obter o record e antes de removê-lo:

```ts
if (['starting', 'running'].includes(record.status)) {
  this.stopHealthCheck(id)
  if (record.captureMode !== 'craft') {
    void this.runHermesMeetPlugin('stop').catch(() => undefined)
  }
  if (record.ownsBrowserInstance) {
    try { this.browserPaneManager.destroyInstance(record.browserInstanceId) } catch { /* pane já fechado */ }
  }
}
```

Decisão registrada: em falha de `start()`, o pane criado permanece aberto de propósito (o usuário vê a página do Meet e a mensagem de erro); só o bot é encerrado.

- [ ] **Step 4: Chave i18n**

Adicionar `meetings.hermesBotBusy` aos 8 locales — en: `"The Hermes bot is already in another meeting ({{url}}). Stop it before starting a new one."` / pt-BR: `"O bot Hermes já está em outra reunião ({{url}}). Encerre-a antes de iniciar uma nova."`.

- [ ] **Step 5: Rodar e ver passar + commit**

```bash
bun test apps/electron/src/main/meetings/meeting-service.test.ts && bun run lint:i18n:parity
git add apps/electron/src/main/meetings/ packages/shared/src/i18n/locales/
git commit -m "fix(meetings): stop leaked Hermes bots and serialize the singleton bot lifecycle"
```

---

## Fase 2 — i18n e UI

### Task 6: i18n completo (chaves ausentes + toolbar hardcoded)

**Files:**
- Modify: `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,pt-BR,zh-Hans}.json`
- Modify: `apps/electron/src/renderer/components/app-shell/MeetingAskButton.tsx:124`, `apps/electron/src/renderer/pages/MeetingsPage.tsx:878,895,906,911`, `apps/electron/src/renderer/browser-toolbar.tsx:297,400-434`
- Modify: `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx:76,114,133,152` (fallbacks `joinError` → chaves por operação)

**Interfaces:**
- Produces: tabela de chaves novas (valores en / pt-BR; traduzir para os outros 6):

| Chave | en | pt-BR |
|---|---|---|
| `meetings.ask` | Ask | Perguntar |
| `meetings.recordingPreview` | Recording preview | Prévia da gravação |
| `meetings.recordingPreviewUnavailable` | The video recording will appear here once the WebM file is saved. | A gravação em vídeo aparecerá aqui quando o arquivo WebM estiver salvo. |
| `meetings.listError` | Could not load meetings. | Não foi possível carregar as reuniões. |
| `meetings.stopError` | Could not stop the meeting. | Não foi possível encerrar a reunião. |
| `meetings.archiveError` | Could not archive the meeting. | Não foi possível arquivar a reunião. |
| `meetings.deleteError` | Could not delete the meeting. | Não foi possível excluir a reunião. |
| `meetings.inviteHermes` | Invite Hermes | Convidar Hermes |
| `meetings.inviteHermesCalling` | Calling… | Chamando... |
| `meetings.inviteHermesSent` | Hermes invited | Hermes chamado |
| `meetings.inviteHermesFailed` | Hermes failed | Hermes falhou |
| `meetings.recordStart` | Record | Gravar |
| `meetings.recordPreparing` | Preparing… | Preparando... |
| `meetings.recordSaving` | Saving… | Salvando... |
| `meetings.recordStop` | Recording • Stop | Gravando • Parar |
| `meetings.recordRetry` | Try again | Tentar de novo |
| `meetings.recordTooltipStart` | Record the meeting video | Gravar vídeo da reunião |
| `meetings.recordTooltipStop` | Stop recording | Parar gravação |
| `meetings.recordingNeedsVideo` | The recording must capture the meeting video. | A gravação precisa capturar vídeo da reunião. |

(+ `meetings.hermesBotBusy` e `meetings.hermesTranscriptEmptyMessage` se as Tasks 4/5 ainda não as adicionaram.)

- [ ] **Step 1: Adicionar as chaves aos 8 locales** (bloco `meetings.*` já existe em cada arquivo ~linha 583; manter ordenação local do bloco).

- [ ] **Step 2: Trocar os usos**

- `MeetingAskButton.tsx:124`: `{t('meetings.ask', 'Perguntar')}` → `{t('meetings.ask')}`.
- `MeetingsPage.tsx:878/906/911`: remover defaultValues PT, usar as chaves novas.
- `MeetingsPage.tsx:895`: substituir `'Finder'` hardcoded pelo padrão de `SessionFilesSection.tsx:680` — copiar a derivação de `fileManagerName` de lá (mesma expressão por plataforma) e interpolar `t('chat.viewInFileManager', { fileManager: fileManagerName })`.
- `browser-toolbar.tsx`: importar `useTranslation` (i18n já é inicializado na linha 27) e trocar os literais das linhas 297, 400-407, 422, 425-433 pelas chaves da tabela.
- `MeetingsListPanel.tsx`: `t('meetings.joinError')` nas linhas 76/114/133/152 → `listError`/`stopError`/`archiveError`/`deleteError` respectivamente.

- [ ] **Step 3: Verificar**

```bash
bun run lint:i18n:parity
grep -rn "Perguntar\|Convidar Hermes\|Gravando • Parar\|Parar gravação\|precisa capturar" apps/electron/src/renderer/ --include='*.tsx' | grep -v locales
```
Expected: parity OK; grep sem resultados (nenhum literal PT restante fora de locales).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/i18n/locales/ apps/electron/src/renderer/
git commit -m "fix(meetings): add missing i18n keys and localize toolbar recording UI"
```

---

### Task 7: Defeitos de UI (reload flash, estado de erro, validação de URL, polling, flush no unmount)

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/MeetingsListPanel.tsx:65-157`
- Modify: `apps/electron/src/renderer/pages/MeetingsPage.tsx:54-79` (validação), `:377-419` (polling)
- Modify: `apps/electron/src/renderer/browser-toolbar.tsx:357-374` (unmount)
- Test: `apps/electron/src/renderer/lib/__tests__/meetings-selection.test.ts` (novo describe para o normalizador — mover a função para lib para testá-la)

**Interfaces:**
- Produces: `normalizeGoogleMeetInput(value: string): string | null` movida para `apps/electron/src/renderer/lib/meetings-selection.ts` (export nomeado; `MeetingsPage.tsx` importa de lá). Rejeita hosts não-Meet e códigos malformados — espelha `normalizeMeetCode` do backend (`meeting-service.ts:1131-1137`).

- [ ] **Step 1: Teste que falha (validação de URL)**

Em `meetings-selection.test.ts`:

```ts
import { normalizeGoogleMeetInput } from '../meetings-selection'

describe('normalizeGoogleMeetInput', () => {
  it('accepts meet codes and meet.google.com URLs', () => {
    expect(normalizeGoogleMeetInput('abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(normalizeGoogleMeetInput('abcdefghij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(normalizeGoogleMeetInput('https://meet.google.com/abc-defg-hij?authuser=1')).toBe('https://meet.google.com/abc-defg-hij')
  })
  it('rejects non-Meet URLs and junk', () => {
    expect(normalizeGoogleMeetInput('https://zoom.us/j/123')).toBeNull()
    expect(normalizeGoogleMeetInput('foo')).toBeNull()
    expect(normalizeGoogleMeetInput('https://evil.com/abc-defg-hij')).toBeNull()
  })
})
```

Run: `bun test apps/electron/src/renderer/lib/__tests__/meetings-selection.test.ts` → FAIL.

- [ ] **Step 2: Implementar o normalizador estrito**

Em `meetings-selection.ts` (mover `GOOGLE_MEET_PREFIX = 'https://meet.google.com/'` junto ou importar):

```ts
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/
const COMPACT_MEET_CODE_RE = /^[a-z]{10}$/

export function normalizeGoogleMeetInput(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname.toLowerCase() !== 'meet.google.com') return null
      const first = url.pathname.split('/').filter(Boolean)[0] ?? ''
      return normalizeCode(first)
    } catch {
      return null
    }
  }
  return normalizeCode(raw.replace(/^meet\.google\.com\//i, ''))
}

function normalizeCode(value: string): string | null {
  const cleaned = value.trim().toLowerCase()
  if (MEET_CODE_RE.test(cleaned)) return `https://meet.google.com/${cleaned}`
  const compact = cleaned.replace(/[^a-z]/g, '')
  if (!COMPACT_MEET_CODE_RE.test(compact)) return null
  return `https://meet.google.com/${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7)}`
}
```

Em `MeetingsPage.tsx`: apagar as funções locais `normalizeGoogleMeetInput`/`extractGoogleMeetMeetingUrl` (linhas 54-96) se esta última não tiver outros usos no arquivo (verificar com grep antes; se tiver, manter só ela) e importar a nova. Nenhuma mudança de comportamento no `canJoin` além de `null` para entradas inválidas.

- [ ] **Step 3: MeetingsListPanel — reload silencioso + estado de erro**

- Linhas 131 e 150: remover `await loadMeetings()` (o dispatch de `MEETINGS_CHANGED_EVENT` na linha anterior já dispara reload silencioso via listener da linha 88).
- Estado de falha de load:

```ts
const [loadFailed, setLoadFailed] = React.useState(false)
```

No `catch` de `loadMeetings` (linha 75-77): `setLoadFailed(true)`; toast só quando `!options?.silent` (evita spam a cada poll de 5s). No sucesso (linha 74): `setLoadFailed(false)`.

Antes do bloco de lista vazia (linha 167), inserir:

```tsx
if (loadFailed && records.length === 0) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium text-foreground">{t('meetings.listError')}</div>
      <Button variant="outline" size="sm" onClick={() => void loadMeetings()}>
        {t('common.retry')}
      </Button>
    </div>
  )
}
```

(Conferir se `common.retry` existe nos locales; se não, adicionar en "Retry" / pt-BR "Tentar novamente" aos 8.)

- [ ] **Step 4: MeetingsPage — backoff do polling em estado terminal**

No effect das linhas 377-419, trocar o `setInterval` fixo de 1.5s por um loop de `setTimeout` reagendado, com período em função do estado:

```ts
let timer: number | undefined
const isSettled = () =>
  (recordRef.current?.status === 'stopped' || recordRef.current?.status === 'error')
  && (transcriptRef.current?.status === 'ready' || transcriptRef.current?.status === 'unavailable')
const schedule = () => {
  if (cancelled) return
  timer = window.setTimeout(async () => {
    await refresh() // corpo atual do tick: status + transcript
    // 1.5s ao vivo; 15s quando terminou (só para captar o summary da análise de vídeo).
    schedule()
  }, isSettled() ? 15_000 : 1_500)
}
schedule()
return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer) }
```

Adaptar aos nomes reais do effect (ler o bloco antes de editar); manter o guard `cancelled` existente. `recordRef`/`transcriptRef` são refs atualizados no próprio `refresh` (criar se o effect hoje usa apenas state).

- [ ] **Step 5: Toolbar — flush completo no unmount**

Substituir o cleanup das linhas 357-374 por:

```ts
useEffect(() => {
  return () => {
    const active = recordingRef.current
    if (!active) return
    recordingRef.current = null
    const finalize = async () => {
      if (active.recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          active.recorder.onstop = () => resolve()
          active.recorder.stop()
        })
      }
      while (active.pendingChunks.size > 0) {
        await Promise.allSettled(Array.from(active.pendingChunks))
      }
      active.stream.getTracks().forEach((track) => track.stop())
      await api?.finalizeRecording(active.id, active.mimeType)
    }
    void finalize().catch((err) => {
      console.error('[browser-toolbar] finalize on unmount failed', err)
    })
  }
}, [api])
```

(Mesma sequência de `stopRecording` — o comentário original sobre persistir o parcial permanece válido.)

- [ ] **Step 6: Rodar e ver passar + commit**

```bash
bun test apps/electron/src/renderer/lib/__tests__/meetings-selection.test.ts && bun run typecheck:electron && bun run lint:i18n:parity
git add apps/electron/src/renderer/
git commit -m "fix(meetings): strict Meet URL validation, list error state, polling backoff, unmount flush"
```

---

## Fase 3 — Robustez e limpeza

### Task 8: Timeout do Deepgram proporcional ao tamanho do arquivo

**Files:**
- Modify: `apps/electron/src/main/meetings/transcription-service.ts:20-24` e uso em `transcribe` (linha ~55)
- Test: `apps/electron/src/main/meetings/transcription-service.isolated.ts`

**Interfaces:**
- Produces: `export function computeFetchTimeoutMs(sizeBytes: number): number`.

- [ ] **Step 1: Teste que falha** (no `.isolated.ts`):

```ts
import { computeFetchTimeoutMs } from './transcription-service'

describe('computeFetchTimeoutMs', () => {
  it('keeps the 10min floor for small files and scales with size up to a 60min cap', () => {
    expect(computeFetchTimeoutMs(0)).toBe(10 * 60_000)
    expect(computeFetchTimeoutMs(100 * 1024 * 1024)).toBeGreaterThan(10 * 60_000) // 100MB
    expect(computeFetchTimeoutMs(4 * 1024 * 1024 * 1024)).toBe(60 * 60_000)       // 4GB → cap
  })
})
```

Run: `bun test ./apps/electron/src/main/meetings/transcription-service.isolated.ts` → FAIL.

- [ ] **Step 2: Implementar**

```ts
const FETCH_TIMEOUT_BASE_MS = 10 * 60_000
const FETCH_TIMEOUT_MAX_MS = 60 * 60_000
/** Uplink conservador para dimensionar o upload de gravações de 1-2GB. */
const ASSUMED_UPLOAD_BYTES_PER_SEC = 1024 * 1024

export function computeFetchTimeoutMs(sizeBytes: number): number {
  const uploadMs = Math.ceil(sizeBytes / ASSUMED_UPLOAD_BYTES_PER_SEC) * 1000
  return Math.min(FETCH_TIMEOUT_BASE_MS + uploadMs, FETCH_TIMEOUT_MAX_MS)
}
```

Em `transcribe()`: o método já faz `stat(input.filePath)` — usar `computeFetchTimeoutMs(stats.size)` no `AbortSignal.timeout(...)`/controller no lugar de `FETCH_TIMEOUT_MS` (ler as linhas 26-71 antes; substituir a constante no ponto único de uso e remover `FETCH_TIMEOUT_MS`).

- [ ] **Step 3: Rodar e ver passar + commit**

```bash
bun test ./apps/electron/src/main/meetings/transcription-service.isolated.ts
git add apps/electron/src/main/meetings/transcription-service.ts apps/electron/src/main/meetings/transcription-service.isolated.ts
git commit -m "fix(meetings): scale Deepgram fetch timeout with recording size"
```

---

### Task 9: Limpeza — handlers mortos, backpressure, path do recording, sanitize, allowlist

**Files:**
- Modify: `apps/electron/src/main/handlers/meetings.ts:110-140,172-195`
- Modify: `apps/electron/src/main/meetings/recording-service.ts:21-26,48-101`
- Modify: `apps/electron/src/main/meetings/meeting-service.ts:1300-1307` (`sanitizeRecord`)
- Modify: `packages/server-core/src/sessions/SessionManager.ts:4131-4134`
- Test: `apps/electron/src/main/meetings/recording-service.test.ts`, `apps/electron/src/main/handlers/__tests__/registration.test.ts` (só rodar, não editar)

- [ ] **Step 1: Remover os handlers ipcMain mortos**

Apagar os três `ipcMain.handle(RPC_NAMESPACES.meetings.ARCHIVE/UNARCHIVE/DELETE, ...)` (`handlers/meetings.ts:172-195`). Nenhum `ipcRenderer` os invoca (preload da toolbar só usa `meetings:start`, `meetings:resolve-workspace`, `meetings:recording:*`); as rotas reais são `server.handle`. `IPC_ONLY_CHANNELS` não os lista — sem mudança de contrato.

- [ ] **Step 2: `RecordingService.prepare` recebe o root resolvido**

`recording-service.ts`:

```ts
export interface PrepareRecordingInput {
  workspaceId: string
  workspaceRoot: string   // resolvido pelo handler via config (getWorkspaceByNameOrId)
  browserInstanceId: string
  meetingId?: string
  urlOrCode?: string
}
```

Em `prepare()`: remover `getWorkspacePath(input.workspaceId)` e o guard morto `if (!workspaceRoot)` (linhas 53-56); usar `input.workspaceRoot` direto em `getWorkspaceMeetingsPath(...)`. Remover o import de `getWorkspacePath`.

No handler `RECORDING_PREPARE` (`handlers/meetings.ts:130-135`): passar `workspaceRoot` (já computado na linha 117).

Atualizar `recording-service.test.ts` para o novo campo.

- [ ] **Step 3: Backpressure no append**

```ts
import { once } from 'node:events'
// ...
async append(recordingId: string, chunk: ArrayBuffer | Uint8Array): Promise<void> {
  // ... guards existentes inalterados ...
  const buffer = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk as ArrayBuffer)
  if (!recording.stream.write(buffer)) {
    await once(recording.stream, 'drain')
  }
  recording.bytesWritten += buffer.byteLength
}
```

Handler `RECORDING_APPEND` (linha 142-144): `return recordingService!.append(...)` (ipcMain.handle propaga a promise; a toolbar já `await`a cada chunk).

- [ ] **Step 4: `sanitizeRecord` não inventa provider**

`meeting-service.ts:1302-1306` — no `catch` da normalização estrita, trocar `transcriptionProvider = DEFAULT_TRANSCRIPTION_PROVIDER` por `transcriptionProvider = undefined` (provider desconhecido é descartado, como registros sem provider).

- [ ] **Step 5: Allowlist do meeting_tool**

`SessionManager.ts:4131-4134`: remover `'www.meet.google.com'` (host inexistente) da allowlist, mantendo `'meet.google.com'`.

- [ ] **Step 6: Rodar e ver passar + commit**

```bash
bun test apps/electron/src/main/meetings/recording-service.test.ts apps/electron/src/main/meetings/meeting-service.test.ts apps/electron/src/main/handlers/__tests__/registration.test.ts apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts packages/shared/src/mcp/session-tools-server.test.ts
bun run lint:tool-contracts
git add apps/electron/src/main/ packages/server-core/src/sessions/SessionManager.ts
git commit -m "chore(meetings): drop dead IPC handlers, fix recording root resolution, add write backpressure"
```

(`lint:tool-contracts` roda porque `SessionManager` foi tocado; a mudança é interna à implementação do `meetingToolFn`, sem alteração de schema — deve passar sem diff de contrato.)

---

### Task 10: Validação final integrada

**Files:** nenhum novo — só execução.

- [ ] **Step 1: Suíte focada completa**

```bash
bun test \
  apps/electron/src/main/meetings/meeting-service.test.ts \
  apps/electron/src/main/meetings/recording-service.test.ts \
  apps/electron/src/main/meetings/meeting-summary-service.test.ts \
  packages/shared/src/workspaces/__tests__/storage-meetings.test.ts \
  apps/electron/src/renderer/lib/__tests__/meetings-selection.test.ts \
  apps/electron/src/main/handlers/__tests__/registration.test.ts \
  apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts \
  packages/shared/src/mcp/session-tools-server.test.ts
bun test ./apps/electron/src/main/meetings/transcription-service.isolated.ts
bun test ./apps/electron/src/main/meetings/meeting-video-analysis-service.isolated.ts
```
Expected: 0 fail.

- [ ] **Step 2: Estática**

```bash
bun run typecheck:electron && bun run typecheck:shared && bun run lint:i18n:parity
```
Expected: tudo limpo.

- [ ] **Step 3: Smoke manual (app rodando)**

1. Abrir a página Meetings, colar `https://zoom.us/j/1` → botão Join desabilitado (validação estrita).
2. Colar um código Meet válido, modo craft → gravar ~10s → parar → transcript vai a `capturing` e depois `ready`/`unavailable` (conforme API key), sem flash de "Carregando..." ao arquivar/excluir.
3. Trocar idioma para EN → nenhuma string PT na página Meetings nem na toolbar de gravação.
4. Corromper manualmente `~/.craft-agent/workspaces/<id>/meetings/meetings.json` (echo garbage) → reiniciar → app cria store novo, backup `.corrupt-*` presente, gravações antigas NÃO deletadas.
5. (Com Hermes bundled e bot-auth configurado) iniciar reunião Hermes → parar → transcript importado do bot; tentar iniciar segunda reunião Hermes com a primeira ativa → erro claro.

- [ ] **Step 4: Commit final de eventuais ajustes**

```bash
git add -A && git commit -m "test(meetings): final validation pass for meetings hardening"
```

---

## Fora de escopo (deliberado)

- **Retenção/paginação de `meetings.json`**: registros são pequenos; sem evidência de dor. Reavaliar com telemetria de tamanho.
- **Leitura/migração de `version` do store**: só existe v1; adicionar migração especulativa é YAGNI. O backup da Task 1 já protege contra formato inesperado.
- **Chave de credencial por `workspaceId` bruto** (finding de baixa confiança, 0.55): o mismatch name-vs-id só ocorre se algum caller endereçar o workspace por nome — a UI atual sempre passa o mesmo id. Verificar com log antes de normalizar; normalizar sem evidência arrisca "perder" chaves já salvas sob o id antigo.
- **`buildToolsMissingStatus` sobrescrevendo o summary estruturado** (video-analysis, P3): impacto restrito a máquinas sem ffmpeg E sem API key; corrigir junto com um passe futuro no formato do summary para não bifurcar `createMeetingSummaryMarkdown` agora.
- **Refactor ARIA das linhas da lista** (controles interativos aninhados em `role="button"`): refactor estrutural de UI sem bug funcional; tratar num passe de a11y dedicado.
- **Dedupe de `resolveCraftConnectionSlug`/`buildTranscriptText`** entre summary/video-analysis services: as variantes já divergiram de propósito (timestamps); unificar agora acopla sem ganho.
