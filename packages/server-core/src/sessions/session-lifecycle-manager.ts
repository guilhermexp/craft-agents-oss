import type { StoredAttachment } from '@craft-agent/core/types'
import type { FileAttachment, SendMessageOptions, Session } from '@craft-agent/shared/protocol'
import type { DispatchMode, SessionBundle } from '@craft-agent/shared/sessions'

export interface SessionLifecycleDelegate {
  initialize(): Promise<void>
  createSession(workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions): Promise<Session>
  getSession(sessionId: string): Promise<Session | null>
  getSessions(workspaceId?: string): Session[]
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  rollbackToMessage(sessionId: string, messageId: string, confirmed: true): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>
  importSession(workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{ sessionId: string; warnings?: string[] }>
}

export class SessionLifecycleManager {
  constructor(private readonly delegate: SessionLifecycleDelegate) {}

  initialize(): Promise<void> {
    return this.delegate.initialize()
  }

  createSession(workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions): Promise<Session> {
    return this.delegate.createSession(workspaceId, options)
  }

  getSession(sessionId: string): Promise<Session | null> {
    return this.delegate.getSession(sessionId)
  }

  getSessions(workspaceId?: string): Session[] {
    return this.delegate.getSessions(workspaceId)
  }

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    return this.delegate.sendMessage(sessionId, message, attachments, storedAttachments, options)
  }

  cancelProcessing(sessionId: string, silent?: boolean): Promise<void> {
    return this.delegate.cancelProcessing(sessionId, silent)
  }

  rollbackToMessage(sessionId: string, messageId: string, confirmed: true): Promise<void> {
    return this.delegate.rollbackToMessage(sessionId, messageId, confirmed)
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.delegate.deleteSession(sessionId)
  }

  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    return this.delegate.exportSession(sessionId, workspaceId)
  }

  importSession(workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{ sessionId: string; warnings?: string[] }> {
    return this.delegate.importSession(workspaceId, bundle, mode)
  }
}
