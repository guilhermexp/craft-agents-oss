import { RPC_NAMESPACES, type MeetingStartInput, type SaveMeetingTranscriptionConfigInput } from '../../shared/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { MeetingService } from '../meetings/meeting-service'
import { RecordingService } from '../meetings/recording-service'
import { ipcMain } from 'electron'
import { getWorkspaceByNameOrId, getWorkspaces } from '@craft-agent/shared/config'
import type { FinalizeRecordingResult } from '../meetings/recording-service'
import type { BrowserPaneManager } from '../browser-pane-manager'

const MEETINGS_RESOLVE_WORKSPACE = 'meetings:resolve-workspace'
const RECORDING_PREPARE = 'meetings:recording:prepare'
const RECORDING_APPEND = 'meetings:recording:append'
const RECORDING_FINALIZE = 'meetings:recording:finalize'
const RECORDING_ABORT = 'meetings:recording:abort'

// ipcMain-only channels used by the browser-pane toolbar recorder. Registered
// via ipcMain.handle (not the RPC server), so they are NOT registered on the RPC server.
export const IPC_ONLY_CHANNELS = [
  MEETINGS_RESOLVE_WORKSPACE,
  RECORDING_PREPARE,
  RECORDING_APPEND,
  RECORDING_FINALIZE,
  RECORDING_ABORT,
] as const

let meetingService: MeetingService | null = null
let recordingService: RecordingService | null = null
let meetingsIpcRegistered = false

/**
 * Logger do host, injetado no registro. Os caminhos de seal exportados abaixo
 * rodam fora do escopo de `registerMeetingHandlers` e precisam logar; importar o
 * logger do main no topo deste módulo puxaria `electron-log` para o grafo dos
 * testes de registro, onde `electron` é mockado.
 */
let hostLogger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void } = {
  info: () => {},
  error: () => {},
}

/** Pane manager do host, injetado no registro pelos mesmos motivos. */
let paneManager: BrowserPaneManager | null = null

function resolveWorkspaceRoot(workspaceId: string | null | undefined): string {
  if (!workspaceId) {
    throw new Error('No workspace context for meetings storage')
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }
  return workspace.rootPath
}

/**
 * Fecha o ciclo de uma gravação craft já finalizada, persistindo o resultado no
 * meeting record. Único ponto de seal: serve o IPC de finalize e os caminhos
 * que selam sem renderer (quit, relaunch, destroy de pane). Lança em falha de
 * persistência para que o shutdown consiga reportar `failed` — o record segue
 * marcado `partial`, que é a leitura correta de uma captura não selada.
 */
async function sealRecording(result: FinalizeRecordingResult): Promise<void> {
  if (!result.meetingId) return
  await meetingService!.completeRecording(
    result.workspaceId,
    resolveWorkspaceRoot(result.workspaceId),
    result.meetingId,
    {
      outputPath: result.outputPath,
      bytesWritten: result.bytesWritten,
      durationMs: result.durationMs,
      mimeType: result.mimeType,
    },
  )
}

async function sealResults(results: FinalizeRecordingResult[]): Promise<number> {
  const settled = await Promise.allSettled(results.map((result) => sealRecording(result)))
  let failures = 0
  settled.forEach((outcome, index) => {
    // Selou ou não, a gravação já saiu da tabela: manter o lock deixaria o pane
    // inadotável para sempre.
    const browserInstanceId = results[index]?.browserInstanceId
    if (browserInstanceId) paneManager?.setCaptureLock(browserInstanceId, null)
    if (outcome.status !== 'rejected') return
    failures += 1
    const reason: unknown = outcome.reason
    hostLogger.error(
      `[meetings] sealing recording for meeting ${results[index]?.meetingId ?? 'unknown'} failed: `
      + (reason instanceof Error ? reason.message : String(reason)),
    )
  })
  return failures
}

/**
 * Sela toda gravação craft ativa antes do app sair ou relançar. O renderer já
 * não tem como dar flush nesse ponto, então perde-se no máximo o último
 * timeslice (~1s) — o resto da captura já está no disco.
 */
export async function shutdownCraftRecordings(): Promise<'idle' | 'sealed' | 'failed'> {
  if (!recordingService) return 'idle'
  const results = await recordingService.finalizeAll()
  if (results.length === 0) return 'idle'
  const failures = await sealResults(results)
  return failures > 0 ? 'failed' : 'sealed'
}

/** Sela a gravação de um pane específico antes de o pane ser destruído. */
export async function sealCraftRecordingsForInstance(browserInstanceId: string): Promise<void> {
  if (!recordingService) return
  await sealResults(await recordingService.finalizeForInstance(browserInstanceId))
}

export function registerMeetingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform, windowManager } = deps
  if (!browserPaneManager) return
  hostLogger = platform.logger
  paneManager = browserPaneManager

  meetingService = meetingService ?? new MeetingService(browserPaneManager)
  recordingService = recordingService ?? new RecordingService(browserPaneManager)

  const resolveContextWorkspaceId = (ctx: { workspaceId?: string | null; webContentsId?: number | null }): string | null | undefined => {
    return ctx.workspaceId
      ?? (typeof ctx.webContentsId === 'number' ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
  }
  const resolveBrowserInstanceWorkspaceId = (browserInstanceId: string): string | null => {
    const instance = browserPaneManager.getLiveInstance(browserInstanceId) as { workspaceId?: string | null; window?: { webContents?: { id?: number } } } | undefined
    if (instance?.workspaceId) {
      return instance.workspaceId
    }
    const webContentsId = instance?.window?.webContents?.id
    return typeof webContentsId === 'number'
      ? (windowManager?.getWorkspaceForWindow(webContentsId) ?? null)
      : null
  }

  if (!meetingsIpcRegistered) {
    meetingsIpcRegistered = true

    // Boot-time recovery: transcripts left in 'capturing' by a crash/quit
    // during the fire-and-forget transcription would otherwise stay stuck
    // forever (ensureLoaded reloads them as-is).
    for (const workspace of getWorkspaces()) {
      void meetingService!.recoverInterruptedTranscriptions(workspace.id, workspace.rootPath).catch((err) => {
        platform.logger.error(`[meetings] transcription recovery failed for workspace ${workspace.id}:`, err)
      })
    }

    ipcMain.handle(MEETINGS_RESOLVE_WORKSPACE, (_event, browserInstanceId: string) => {
      const workspaceId = resolveBrowserInstanceWorkspaceId(browserInstanceId)
      if (!workspaceId) {
        throw new Error(`No workspace context for browser instance: ${browserInstanceId}`)
      }
      return workspaceId
    })

    ipcMain.handle(RPC_NAMESPACES.meetings.START, async (_event, workspaceIdOrInput: string | MeetingStartInput, maybeInput?: string | MeetingStartInput) => {
      try {
        const workspaceId = maybeInput === undefined
          ? windowManager?.getWorkspaceForWindow(_event.sender.id)
          : String(workspaceIdOrInput)
        const input = maybeInput ?? workspaceIdOrInput
        return await meetingService!.start(resolveWorkspaceRoot(workspaceId), input)
      } catch (err) {
        platform.logger.error('[meetings] toolbar start failed:', err)
        throw err
      }
    })

    ipcMain.handle(RECORDING_PREPARE, async (_event, payload: { workspaceId?: string; browserInstanceId: string; urlOrCode?: string; mimeType: string }) => {
      try {
        const workspaceId = payload.workspaceId
          ?? resolveBrowserInstanceWorkspaceId(payload.browserInstanceId)
        if (!workspaceId) {
          throw new Error(`No workspace context for browser instance: ${payload.browserInstanceId}`)
        }
        const workspaceRoot = resolveWorkspaceRoot(workspaceId)
        const meeting = payload.urlOrCode
          ? await meetingService!.start(workspaceRoot, {
            urlOrCode: payload.urlOrCode,
            captureMode: 'craft',
            browserInstanceId: payload.browserInstanceId,
            title: 'Google Meet',
            transcribe: true,
          })
          : null
        if (meeting?.status === 'error') {
          throw new Error(meeting.error || 'Could not create meeting recording record')
        }
        const prepared = recordingService!.prepare({
          workspaceId,
          workspaceRoot,
          browserInstanceId: payload.browserInstanceId,
          meetingId: meeting?.id,
          urlOrCode: payload.urlOrCode,
          mimeType: payload.mimeType,
        })
        // Referencia o arquivo já como parcial: um crash/quit daqui em diante
        // deixa a captura no disco em vez de virar órfã no próximo boot.
        if (meeting?.id) {
          meetingService!.attachRecordingTarget(workspaceRoot, meeting.id, {
            outputPath: prepared.outputPath,
            mimeType: payload.mimeType,
          })
        }
        // Enquanto a captura roda, o pane sai do pool de adoção por sessão de
        // agente: navegar a página não encerra as faixas, então a gravação
        // seguiria com a tela do agente dentro do mesmo arquivo.
        browserPaneManager.setCaptureLock(payload.browserInstanceId, {
          reason: 'meeting-recording',
          since: Date.now(),
        })
        return prepared
      } catch (err) {
        platform.logger.error('[meetings] recording prepare failed:', err)
        throw err
      }
    })

    ipcMain.handle(RECORDING_APPEND, (_event, recordingId: string, chunk: ArrayBuffer | Uint8Array) => {
      return recordingService!.append(recordingId, chunk)
    })

    ipcMain.handle(RECORDING_FINALIZE, async (_event, recordingId: string, mimeType?: string) => {
      // Resolvido antes: se `finalize` lançar (stream em erro), não há resultado
      // de onde tirar o pane, e um lock vazado o tornaria inadotável para sempre.
      const lockedInstanceId = recordingService!.getBrowserInstanceId(recordingId)
      try {
        const result = await recordingService!.finalize(recordingId, mimeType)
        try {
          await sealRecording(result)
        } catch (err) {
          platform.logger.error('[meetings] completeRecording failed:', err)
        }
        return result
      } finally {
        if (lockedInstanceId) browserPaneManager.setCaptureLock(lockedInstanceId, null)
      }
    })

    ipcMain.handle(RECORDING_ABORT, (_event, recordingId: string) => {
      const aborted = recordingService!.abort(recordingId)
      if (!aborted) return
      browserPaneManager.setCaptureLock(aborted.browserInstanceId, null)
      if (aborted.meetingId) {
        try {
          meetingService!.stop(aborted.workspaceId, resolveWorkspaceRoot(aborted.workspaceId), aborted.meetingId)
        } catch (err) {
          platform.logger.error('[meetings] closing meeting record after abort failed:', err)
        }
      }
    })

    // Destruir um pane (fechar de verdade, trocar/remover perfil) sela a
    // gravação antes do teardown: o hook é fire-and-forget porque o destroy é
    // síncrono, e o que já foi escrito está no disco.
    browserPaneManager.setCaptureReleaseHook((browserInstanceId) => {
      void sealCraftRecordingsForInstance(browserInstanceId).catch((err: unknown) => {
        platform.logger.error('[meetings] sealing recording on pane destroy failed:', err)
      })
    })
  }

  server.handle(RPC_NAMESPACES.meetings.START, async (ctx, workspaceIdOrInput: string | MeetingStartInput, maybeInput?: string | MeetingStartInput) => {
    try {
      const workspaceId = maybeInput === undefined
        ? resolveContextWorkspaceId(ctx)
        : String(workspaceIdOrInput)
      const input = maybeInput ?? workspaceIdOrInput
      return await meetingService!.start(resolveWorkspaceRoot(workspaceId), input)
    } catch (err) {
      platform.logger.error('[meetings] start failed:', err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.LIST, (ctx, workspaceId?: string) => {
    const resolvedWorkspaceId = workspaceId ?? resolveContextWorkspaceId(ctx)
    return meetingService!.list(resolveWorkspaceRoot(resolvedWorkspaceId))
  })

  server.handle(RPC_NAMESPACES.meetings.STATUS, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    return meetingService!.status(resolveWorkspaceRoot(workspaceId), id)
  })

  server.handle(RPC_NAMESPACES.meetings.STOP, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    try {
      return meetingService!.stop(workspaceId!, resolveWorkspaceRoot(workspaceId), id)
    } catch (err) {
      platform.logger.error(`[meetings] stop failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.TRANSCRIPT, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    try {
      return meetingService!.transcript(resolveWorkspaceRoot(workspaceId), id)
    } catch (err) {
      // "Meeting not found" is a benign, client-handled race (the renderer polls
      // a stale selection and clears it on this error). Don't spam a stacktrace.
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('Meeting not found:')) {
        platform.logger.debug?.(`[meetings] transcript for missing meeting ${id} (client will clear selection)`)
      } else {
        platform.logger.error(`[meetings] transcript failed for ${id}:`, err)
      }
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.GET_TRANSCRIPTION_CONFIG, async (ctx, workspaceId?: string) => {
    const resolvedWorkspaceId = workspaceId ?? resolveContextWorkspaceId(ctx)
    if (!resolvedWorkspaceId) {
      throw new Error('No workspace context for meeting transcription settings')
    }
    return await meetingService!.getTranscriptionConfig(resolvedWorkspaceId, resolveWorkspaceRoot(resolvedWorkspaceId))
  })

  server.handle(RPC_NAMESPACES.meetings.SAVE_TRANSCRIPTION_CONFIG, async (
    ctx,
    workspaceIdOrInput: string | SaveMeetingTranscriptionConfigInput,
    maybeInput?: SaveMeetingTranscriptionConfigInput,
  ) => {
    const workspaceId = maybeInput === undefined
      ? resolveContextWorkspaceId(ctx)
      : String(workspaceIdOrInput)
    const input = maybeInput ?? workspaceIdOrInput
    if (!workspaceId) {
      throw new Error('No workspace context for meeting transcription settings')
    }
    if (typeof input === 'string') {
      throw new Error('Invalid meeting transcription settings payload')
    }
    return await meetingService!.saveTranscriptionConfig(workspaceId, resolveWorkspaceRoot(workspaceId), input)
  })

  server.handle(RPC_NAMESPACES.meetings.ARCHIVE, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    try {
      return meetingService!.archive(resolveWorkspaceRoot(workspaceId), id)
    } catch (err) {
      platform.logger.error(`[meetings] archive failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.UNARCHIVE, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    try {
      return meetingService!.unarchive(resolveWorkspaceRoot(workspaceId), id)
    } catch (err) {
      platform.logger.error(`[meetings] unarchive failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.DELETE, (ctx, workspaceIdOrId: string, maybeId?: string) => {
    const workspaceId = maybeId === undefined
      ? resolveContextWorkspaceId(ctx)
      : workspaceIdOrId
    const id = maybeId ?? workspaceIdOrId
    try {
      meetingService!.deleteMeeting(resolveWorkspaceRoot(workspaceId), id)
    } catch (err) {
      platform.logger.error(`[meetings] delete failed for ${id}:`, err)
      throw err
    }
  })
}
