import { RPC_NAMESPACES, type MeetingStartInput, type SaveMeetingTranscriptionConfigInput } from '../../shared/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { MeetingService } from '../meetings/meeting-service'
import { ipcMain } from 'electron'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'

const MEETINGS_RESOLVE_WORKSPACE = 'meetings:resolve-workspace'

export const HANDLED_CHANNELS = [
  RPC_NAMESPACES.meetings.START,
  MEETINGS_RESOLVE_WORKSPACE,
  RPC_NAMESPACES.meetings.LIST,
  RPC_NAMESPACES.meetings.STATUS,
  RPC_NAMESPACES.meetings.STOP,
  RPC_NAMESPACES.meetings.TRANSCRIPT,
  RPC_NAMESPACES.meetings.GET_TRANSCRIPTION_CONFIG,
  RPC_NAMESPACES.meetings.SAVE_TRANSCRIPTION_CONFIG,
] as const

let meetingService: MeetingService | null = null
let meetingsIpcRegistered = false

export function registerMeetingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform, windowManager } = deps
  if (!browserPaneManager) return

  meetingService = meetingService ?? new MeetingService(browserPaneManager)

  const resolveWorkspaceRoot = (workspaceId: string | null | undefined): string => {
    if (!workspaceId) {
      throw new Error('No workspace context for meetings storage')
    }
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`)
    }
    return workspace.rootPath
  }
  const resolveContextWorkspaceId = (ctx: { workspaceId?: string | null; webContentsId?: number | null }): string | null | undefined => {
    return ctx.workspaceId
      ?? (typeof ctx.webContentsId === 'number' ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
  }
  const resolveBrowserInstanceWorkspaceId = (browserInstanceId: string): string | null => {
    const instance = browserPaneManager.getInstance(browserInstanceId) as { workspaceId?: string | null; window?: { webContents?: { id?: number } } } | undefined
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
      return meetingService!.stop(resolveWorkspaceRoot(workspaceId), id)
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
      platform.logger.error(`[meetings] transcript failed for ${id}:`, err)
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
}
