/**
 * IMessagingGatewayRegistry — abstract interface for messaging gateway access.
 *
 * RPC handlers in server-core program against this interface;
 * the concrete MessagingGatewayRegistry satisfies it at runtime.
 */

export interface MessagingBindingInfo {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  messagingChannelId: string
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  /**
   * Per-binding access policy. Optional for back-compat with legacy clients
   * that don't yet display this field. Phase 3 wires the renderer.
   */
  accessMode?: 'inherit' | 'allow-list' | 'open'
  allowedSenderIds?: string[]
}

/**
 * Workspace-level Telegram supergroup configuration. Set by pairing the
 * workspace to a supergroup via the new `/pair <code>` workspace flow;
 * unset via `unbindWorkspaceSupergroup`.
 */
export interface MessagingSupergroupInfo {
  chatId: string
  title: string
  capturedAt: number
}

export interface MessagingPlatformRuntimeInfo {
  platform: string
  configured: boolean
  connected: boolean
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
  identity?: string
  lastError?: string
  updatedAt: number
}

/**
 * A user authorised to drive the workspace's bot at the platform level.
 * Mirrors `PlatformOwner` in `@craft-agent/messaging-gateway` — kept here
 * to avoid the renderer / RPC layer importing the gateway package directly.
 */
export interface MessagingPlatformOwnerInfo {
  userId: string
  displayName?: string
  username?: string
  addedAt: number
}

/**
 * Why a sender ended up in the pending list. Drives the UI's "Allow" button
 * label and the gateway's promotion semantics.
 */
export type MessagingPendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

/**
 * A sender the gateway recently rejected. Surfaces in Settings → Messaging
 * as "Pending requests".
 */
export interface MessagingPendingSenderInfo {
  platform: string
  userId: string
  displayName?: string
  username?: string
  lastAttemptAt: number
  attemptCount: number
  /** Why the sender was rejected. Optional for back-compat with persisted
   *  entries written by an earlier build that lacked the field. */
  reason?: MessagingPendingRejectReason
  /** Binding context (only for 'not-on-binding-allowlist' rejects). */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export type MessagingPlatformAccessMode = 'open' | 'owner-only'

export type MessagingBindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface MessagingConfigInfo {
  enabled: boolean
  /**
   * Per-platform config. Telegram may carry optional `supergroup`,
   * `accessMode`, and `owners` fields; other platforms only use `enabled`.
   */
  platforms: Record<
    string,
    | {
        enabled: boolean
        supergroup?: MessagingSupergroupInfo
        accessMode?: MessagingPlatformAccessMode
        owners?: MessagingPlatformOwnerInfo[]
      }
    | undefined
  >
  runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
}

export interface IMessagingGatewayRegistry {
  /** Get bindings for a workspace. */
  getBindings(workspaceId: string): MessagingBindingInfo[]

  /** Get messaging config and runtime state for a workspace. */
  getConfig(workspaceId: string): MessagingConfigInfo | null

  /** Update messaging config for a workspace. */
  updateConfig(workspaceId: string, config: Partial<MessagingConfigInfo>): Promise<void>

  /** Generate a pairing code for binding a session to a chat. */
  generatePairingCode(workspaceId: string, sessionId: string, platform: string): { code: string; expiresAt: number; botUsername?: string }

  /**
   * Generate a pairing code that, when typed in a Telegram supergroup,
   * registers that supergroup at the workspace level. Phase A of the topics
   * feature — currently Telegram-only.
   */
  generateSupergroupPairingCode(
    workspaceId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string }

  /** Read the workspace's currently paired Telegram supergroup, if any. */
  getWorkspaceSupergroup(workspaceId: string): MessagingSupergroupInfo | null

  /** Unbind the workspace from its currently paired Telegram supergroup. */
  unbindWorkspaceSupergroup(workspaceId: string): Promise<void>

  /**
   * Bind a freshly-spawned automation session to a Telegram forum topic in
   * the paired supergroup (creating the topic if it doesn't exist yet).
   * Best-effort — returns a discriminated result instead of throwing so
   * callers can log + continue without blocking the session.
   */
  bindAutomationSession(args: {
    workspaceId: string
    sessionId: string
    topicName: string
  }): Promise<
    | { ok: true; chatId: string; threadId: number; reused: boolean }
    | {
        ok: false
        reason: 'invalid-name' | 'no-supergroup' | 'no-adapter' | 'topic-create-failed'
        error?: string
      }
  >

  /**
   * Drop a cached automation topic entry. Does not delete the Telegram topic
   * itself. Useful when an automation is renamed/removed and the user wants
   * the next use of the same name to create a fresh topic.
   */
  removeAutomationTopic(workspaceId: string, topicName: string): Promise<void>

  /** Unbind all bindings for a session, optionally limited to one platform. */
  unbindSession(workspaceId: string, sessionId: string, platform?: string): void

  /** Unbind one specific binding row by ID. */
  unbindBinding(workspaceId: string, bindingId: string): boolean

  /** Verify a platform credential without persisting it. */
  testCredential(
    platform: string,
    credential: string,
  ): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>

  /**
   * Connect a platform for a workspace. Credential-based platforms (Telegram)
   * pass the raw `credential` (validated + persisted here); interactive
   * platforms (WhatsApp) omit it and start their link flow instead.
   */
  connectPlatform(workspaceId: string, platform: string, credential?: string): Promise<void>

  /** Disable a platform for a workspace, preserving WhatsApp auth state unless forgotten separately. */
  disconnectPlatform(workspaceId: string, platform: string): Promise<void>

  /** Disable a platform and forget its local auth/device state when supported. */
  forgetPlatform(workspaceId: string, platform: string): Promise<void>

  /**
   * Submit interactive pairing input to a platform mid-link (currently the
   * WhatsApp phone number). Only meaningful for platforms with an interactive
   * link flow; call after `connectPlatform`.
   */
  submitPairingInput(workspaceId: string, platform: string, input: string): Promise<void>

  // -------------------------------------------------------------------------
  // Access control (Phase 2/3)
  // -------------------------------------------------------------------------

  /** Read the platform's owners list (workspace-scoped). */
  getPlatformOwners(workspaceId: string, platform: string): MessagingPlatformOwnerInfo[]

  /** Replace the platform's owners list. */
  setPlatformOwners(
    workspaceId: string,
    platform: string,
    owners: MessagingPlatformOwnerInfo[],
  ): MessagingPlatformOwnerInfo[]

  /** Read the workspace's platform-level access policy. */
  getPlatformAccessMode(workspaceId: string, platform: string): MessagingPlatformAccessMode

  /** Set the workspace's platform-level access policy. */
  setPlatformAccessMode(
    workspaceId: string,
    platform: string,
    mode: MessagingPlatformAccessMode,
  ): void

  /**
   * List senders the gateway recently rejected. Surfaces in Settings →
   * Messaging as "Pending requests". Optional `platform` filter.
   */
  getPendingSenders(workspaceId: string, platform?: string): MessagingPendingSenderInfo[]

  /** Drop a pending sender without promoting them. */
  dismissPendingSender(workspaceId: string, platform: string, userId: string): boolean

  /**
   * Allow a pending sender. Branches on the entry's `reason`:
   * - `'not-owner'` → adds to platform owners.
   * - `'not-on-binding-allowlist'` → appends to that binding's allow-list
   *   (does NOT touch workspace owners).
   *
   * `entryKey` lets the UI target a specific row when a sender has
   * multiple pending rows (e.g. workspace + binding-level rejects).
   * Throws when the entry can't be found or the targeted binding has
   * been unbound between reject and Allow.
   */
  allowPendingSender(
    workspaceId: string,
    platform: string,
    userId: string,
    entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string },
  ): { owners: MessagingPlatformOwnerInfo[]; bindingId?: string }

  /** Update the access policy on a single binding. */
  setBindingAccess(
    workspaceId: string,
    bindingId: string,
    access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] },
  ): void
}
