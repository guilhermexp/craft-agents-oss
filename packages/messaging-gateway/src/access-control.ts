/**
 * Access-control matrix — single source of truth for "may this sender
 * route to this binding / run this pre-binding command?"
 *
 * Router and commands share one implementation across two layers:
 *   - Pure evaluators (`evaluatePreBindingAccess`, `evaluateBindingAccess`)
 *     plus the config readers return a discriminated verdict with no side
 *     effects, so unit tests can exhaustively cover the permission matrix
 *     without standing up a full gateway.
 *   - `resolvePendingPromotion` applies a verdict, mutating the binding and
 *     pending-sender stores in place to promote a rejected sender.
 */

import type { PendingSendersStore } from './pending-senders'
import type { BindingStore } from './binding-store'
import type {
  BindingConfig,
  IncomingMessage,
  MessagingConfig,
  MessagingChannelId,
  MessagingLogger,
  PendingRejectReason,
  PlatformAccessMode,
  PlatformAdapter,
  PlatformOwner,
  PlatformType,
} from './types'

/**
 * Cooldown window for friendly rejection replies. A non-owner who pings
 * the bot every second shouldn't get a reply every second — the reply
 * itself becomes spam, and a malicious sender can use it to wedge the
 * bot's own outgoing pipeline.
 */
export const REJECT_REPLY_COOLDOWN_MS = 60 * 60 * 1000

export type AccessDecision =
  | { allow: true }
  | { allow: false; reason: AccessRejectReason }

export type AccessRejectReason =
  /** The sender is a bot (Telegram `from.is_bot`). Always silent-drop. */
  | 'bot-sender'
  /** Workspace mode is `'owner-only'` and sender is not on the owners list. */
  | 'not-owner'
  /** Binding mode is `'allow-list'` and sender is not on `allowedSenderIds`. */
  | 'not-on-binding-allowlist'

export interface PreBindingAccessInput {
  /** The inbound message about to be handled by Commands. */
  msg: IncomingMessage
  /** Workspace messaging config (for `accessMode` + `owners`). */
  workspaceConfig: MessagingConfig
}

/**
 * Decide whether `msg` may run a pre-binding command (`/new`, `/bind`, etc.)
 * — i.e. one that operates on the workspace before any binding exists.
 *
 * Rules:
 *  - Bot senders are always rejected (silent-drop expected upstream).
 *  - When the platform's `accessMode` is missing or `'open'`, allow.
 *  - When `'owner-only'`, allow iff the sender is on `owners`.
 */
export function evaluatePreBindingAccess(
  input: PreBindingAccessInput,
): AccessDecision {
  const { msg, workspaceConfig } = input
  if (msg.senderIsBot) return { allow: false, reason: 'bot-sender' }

  const mode = readPlatformAccessMode(workspaceConfig, msg.platform)
  if (mode === 'open') return { allow: true }

  const owners = readPlatformOwners(workspaceConfig, msg.platform)
  if (owners.some((o) => o.userId === msg.senderId)) return { allow: true }
  return { allow: false, reason: 'not-owner' }
}

export interface BindingAccessInput {
  msg: IncomingMessage
  workspaceConfig: MessagingConfig
  binding: { config: BindingConfig }
}

/**
 * Decide whether `msg` may route to an existing binding.
 *
 * Resolution order:
 *  1. Bot sender → reject.
 *  2. Binding `accessMode === 'open'` → allow.
 *  3. Binding `accessMode === 'allow-list'` → allow iff sender is in
 *     `allowedSenderIds`.
 *  4. Binding `accessMode === 'inherit'` → defer to workspace policy:
 *     `'open'` allows; `'owner-only'` requires sender on `owners`.
 *
 * Note: a `'open'` workspace + `'inherit'` binding is the legacy/migration
 * path. It deliberately allows traffic so existing prod workspaces don't
 * silently break the day this code ships.
 */
export function evaluateBindingAccess(input: BindingAccessInput): AccessDecision {
  const { msg, workspaceConfig, binding } = input
  if (msg.senderIsBot) return { allow: false, reason: 'bot-sender' }

  const mode = binding.config.accessMode
  if (mode === 'open') return { allow: true }

  if (mode === 'allow-list') {
    return binding.config.allowedSenderIds.includes(msg.senderId)
      ? { allow: true }
      : { allow: false, reason: 'not-on-binding-allowlist' }
  }

  // mode === 'inherit'
  const wsMode = readPlatformAccessMode(workspaceConfig, msg.platform)
  if (wsMode === 'open') return { allow: true }
  const owners = readPlatformOwners(workspaceConfig, msg.platform)
  return owners.some((o) => o.userId === msg.senderId)
    ? { allow: true }
    : { allow: false, reason: 'not-owner' }
}

/**
 * Read the workspace's platform-level access mode, defaulting to `'open'`
 * for back-compat with configs that predate this field.
 */
export function readPlatformAccessMode(
  config: MessagingConfig,
  platform: PlatformType,
): PlatformAccessMode {
  return config.platforms[platform]?.accessMode ?? 'open'
}

/** Read the platform's owners list (empty when not configured). */
export function readPlatformOwners(
  config: MessagingConfig,
  platform: PlatformType,
): PlatformOwner[] {
  return config.platforms[platform]?.owners ?? []
}

/** De-duplicate an owners list by `userId`, keeping the last write per id. */
export function dedupeOwners(owners: PlatformOwner[]): PlatformOwner[] {
  const byId = new Map<string, PlatformOwner>()
  for (const owner of owners) {
    if (!owner?.userId) continue
    byId.set(owner.userId, { ...owner })
  }
  return Array.from(byId.values())
}

/**
 * Decide how to seed the first owner for a platform. The `/pair` flow calls
 * this on redeem: if no owner exists yet, the consuming sender becomes the
 * first owner and the workspace defaults to `'owner-only'` (an existing
 * explicit mode is respected). Returns the list + mode to persist and whether
 * anything changed; the caller persists when `changed`.
 */
export function resolveOwnerSeed(
  config: MessagingConfig,
  platform: PlatformType,
  candidate: PlatformOwner,
): { changed: boolean; owners: PlatformOwner[]; accessMode: PlatformAccessMode } {
  const currentOwners = readPlatformOwners(config, platform)
  if (currentOwners.length > 0) {
    return { changed: false, owners: currentOwners, accessMode: readPlatformAccessMode(config, platform) }
  }
  return {
    changed: true,
    owners: [candidate],
    accessMode: config.platforms[platform]?.accessMode ?? 'owner-only',
  }
}

/** Outcome of promoting a pending sender. Store mutations (binding allow-list,
 *  pending dismissal) are applied in-place; owner-list changes are returned for
 *  the caller to persist. */
export interface PendingPromotionResult {
  /** Owners list for the RPC reply. */
  owners: PlatformOwner[]
  /** Binding targeted by a `'not-on-binding-allowlist'` promotion. */
  bindingId?: string
  /** Present only when the owners list changed and must be persisted. */
  ownersToPersist?: PlatformOwner[]
  /** Access mode to persist alongside `ownersToPersist`. */
  accessModeToPersist?: PlatformAccessMode
  /** Whether the caller should emit a binding-changed event. */
  bindingChanged: boolean
}

/**
 * Promote a pending sender. Branches on the entry's `reason`:
 *  - `'not-owner'` → add to platform owners (unless already an owner).
 *  - `'not-on-binding-allowlist'` → append to that binding's `allowedSenderIds`
 *    (and force the binding to `'allow-list'` mode), leaving workspace owners
 *    untouched — this closes the privilege-escalation footgun where a sender
 *    denied by one binding would have been promoted to workspace owner.
 *
 * `entryKey` targets a specific pending row when a sender has several. Throws
 * when no matching entry exists, when a binding-scoped entry lacks a bindingId,
 * or when the targeted binding was unbound between reject and allow (the stale
 * pending entry is dismissed in that case).
 */
export function resolvePendingPromotion(args: {
  config: MessagingConfig
  platform: PlatformType
  userId: string
  entryKey: { reason?: PendingRejectReason; bindingId?: string } | undefined
  bindingStore: BindingStore
  pendingStore: PendingSendersStore
}): PendingPromotionResult {
  const { config, platform, userId, entryKey, bindingStore, pendingStore } = args
  const match = pendingStore.list(platform).find(
    (p) =>
      p.userId === userId &&
      (entryKey?.reason === undefined || (p.reason ?? 'not-owner') === entryKey.reason) &&
      (entryKey?.bindingId === undefined || p.bindingId === entryKey.bindingId),
  )
  if (!match) {
    throw new Error('Pending sender not found — they may have been dismissed.')
  }

  const reason = match.reason ?? 'not-owner'

  if (reason === 'not-on-binding-allowlist') {
    const bindingId = match.bindingId
    if (!bindingId) {
      throw new Error('Pending entry is binding-scoped but has no bindingId.')
    }
    const binding = bindingStore.getAll().find((b) => b.id === bindingId)
    if (!binding) {
      // Binding was unbound between reject and allow. Drop the stale entry and
      // surface a meaningful error so the operator knows to re-pair.
      pendingStore.dismiss(platform, userId, { reason: 'not-on-binding-allowlist', bindingId })
      throw new Error('Binding no longer exists — pending entry dismissed.')
    }
    const allowedSenderIds = Array.from(new Set([...binding.config.allowedSenderIds, userId]))
    bindingStore.updateBindingConfig(bindingId, { allowedSenderIds, accessMode: 'allow-list' })
    pendingStore.dismiss(platform, userId, { reason: 'not-on-binding-allowlist', bindingId })
    return { owners: readPlatformOwners(config, platform), bindingId, bindingChanged: true }
  }

  // reason === 'not-owner': promote to workspace owner.
  const existing = readPlatformOwners(config, platform)
  if (existing.some((o) => o.userId === userId)) {
    pendingStore.dismiss(platform, userId)
    return { owners: existing, bindingChanged: false }
  }
  const ownersToPersist: PlatformOwner[] = [
    ...existing,
    {
      userId: match.userId,
      ...(match.displayName ? { displayName: match.displayName } : {}),
      ...(match.username ? { username: match.username } : {}),
      addedAt: Date.now(),
    },
  ]
  // Dismiss every pending row for this sender — as an owner they inherit access
  // for inherit-mode bindings, so binding-allow-list rejects are superseded.
  pendingStore.dismiss(platform, userId)
  return {
    owners: ownersToPersist,
    ownersToPersist,
    accessModeToPersist: config.platforms[platform]?.accessMode ?? 'owner-only',
    bindingChanged: true,
  }
}

/**
 * Inbound stimulus identity. Subset of `IncomingMessage` / `ButtonPress`
 * that the rejection helper needs — extracting the common shape avoids a
 * "fake an IncomingMessage" pattern at the button callsite.
 */
export interface RejectableSender {
  platform: PlatformType
  messagingChannelId: MessagingChannelId
  threadId?: number
  senderId: string
  senderName?: string
  senderUsername?: string
}

export interface RejectionExecutionContext {
  /** Per-(platform, senderId) cooldown map. Mutated. */
  recentRejectReplies: Map<string, number>
  /** Optional pending-senders store. Records non-bot rejections. */
  pendingStore?: PendingSendersStore
}

/**
 * Shared rejection path: log, record in pending store, send the friendly
 * reply with cooldown. Used by `Router.handleReject` (text path),
 * `Commands.sendRejection` (pre-binding text path), and
 * `MessagingGateway.handleButtonPress` (callback button path) so all
 * three entry points behave identically.
 */
export async function executeRejection(
  adapter: PlatformAdapter,
  sender: RejectableSender,
  reason: AccessRejectReason,
  ctx: RejectionExecutionContext,
  log: MessagingLogger,
  extra: { bindingId?: string; sessionId?: string } = {},
): Promise<void> {
  log.info('access-control rejected stimulus', {
    event: 'access_rejected',
    reason,
    platform: sender.platform,
    messagingChannelId: sender.messagingChannelId,
    threadId: sender.threadId,
    senderId: sender.senderId,
    senderUsername: sender.senderUsername,
    bindingId: extra.bindingId,
    sessionId: extra.sessionId,
  })

  if (reason !== 'bot-sender') {
    // Map the access verdict reason into the pending-store reason. The
    // store only cares about the two "user-facing" reasons (workspace vs.
    // binding) — bot-sender is silent-dropped before reaching here.
    const pendingReason =
      reason === 'not-on-binding-allowlist' ? 'not-on-binding-allowlist' : 'not-owner'
    ctx.pendingStore?.recordRejection({
      platform: sender.platform,
      senderId: sender.senderId,
      senderName: sender.senderName,
      senderUsername: sender.senderUsername,
      reason: pendingReason,
      ...(extra.bindingId ? { bindingId: extra.bindingId } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(sender.messagingChannelId ? { channelId: sender.messagingChannelId } : {}),
      ...(sender.threadId !== undefined ? { threadId: sender.threadId } : {}),
    })
  }

  const replyText = buildRejectionReply(reason)
  if (!replyText) return

  const key = `${sender.platform}:${sender.senderId}`
  const last = ctx.recentRejectReplies.get(key) ?? 0
  if (Date.now() - last < REJECT_REPLY_COOLDOWN_MS) return
  ctx.recentRejectReplies.set(key, Date.now())

  try {
    await adapter.sendText(sender.messagingChannelId, replyText, {
      ...(sender.threadId !== undefined ? { threadId: sender.threadId } : {}),
    })
  } catch (err) {
    log.warn('failed to send rejection reply (non-fatal)', {
      event: 'reject_reply_failed',
      platform: sender.platform,
      messagingChannelId: sender.messagingChannelId,
      error: err,
    })
  }
}

/**
 * Friendly reply text for a rejected sender. Returns null when the verdict
 * was `bot-sender` (no reply — bot loops are a hazard).
 */
export function buildRejectionReply(reason: AccessRejectReason): string | null {
  switch (reason) {
    case 'bot-sender':
      return null
    case 'not-owner':
      return 'This bot is private. Ask the owner to invite you in the Craft Agent app.'
    case 'not-on-binding-allowlist':
      return "You're not on the allow-list for this conversation. Ask the owner to add you."
  }
}
