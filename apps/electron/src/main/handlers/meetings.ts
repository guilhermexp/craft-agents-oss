import { RPC_NAMESPACES, type MeetingStartInput } from '../../shared/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { MeetingService } from '../meetings/meeting-service'
import { ipcMain } from 'electron'

export const HANDLED_CHANNELS = [
  RPC_NAMESPACES.meetings.START,
  RPC_NAMESPACES.meetings.LIST,
  RPC_NAMESPACES.meetings.STATUS,
  RPC_NAMESPACES.meetings.STOP,
  RPC_NAMESPACES.meetings.TRANSCRIPT,
] as const

let meetingService: MeetingService | null = null
let meetingsIpcRegistered = false

export function registerMeetingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform } = deps
  if (!browserPaneManager) return

  meetingService = meetingService ?? new MeetingService(browserPaneManager)

  if (!meetingsIpcRegistered) {
    meetingsIpcRegistered = true
    ipcMain.handle(RPC_NAMESPACES.meetings.START, async (_event, input: string | MeetingStartInput) => {
      try {
        return await meetingService!.start(input)
      } catch (err) {
        platform.logger.error('[meetings] toolbar start failed:', err)
        throw err
      }
    })
  }

  server.handle(RPC_NAMESPACES.meetings.START, async (_ctx, input: string | MeetingStartInput) => {
    try {
      return await meetingService!.start(input)
    } catch (err) {
      platform.logger.error('[meetings] start failed:', err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.LIST, () => {
    return meetingService!.list()
  })

  server.handle(RPC_NAMESPACES.meetings.STATUS, (_ctx, id: string) => {
    return meetingService!.status(id)
  })

  server.handle(RPC_NAMESPACES.meetings.STOP, (_ctx, id: string) => {
    try {
      return meetingService!.stop(id)
    } catch (err) {
      platform.logger.error(`[meetings] stop failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.meetings.TRANSCRIPT, (_ctx, id: string) => {
    try {
      return meetingService!.transcript(id)
    } catch (err) {
      platform.logger.error(`[meetings] transcript failed for ${id}:`, err)
      throw err
    }
  })
}
