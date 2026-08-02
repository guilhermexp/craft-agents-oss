/**
 * Typed event map for server → client push channels.
 * Keys are channel string literals, values are argument tuples.
 */

import type { ThemeOverrides } from '../config/index'
import type { PublicSourceDto } from '../sources/public-source-dto'
import type { LoadedSkill } from '../skills/types'
import type { LoadedProject } from '../projects/types'
import { RPC_NAMESPACES } from './channels'
import type {
  SessionEvent,
  UnreadSummary,
  UpdateInfo,
  BrowserInstanceInfo,
  DeepLinkNavigation,
  TaskGenerateResult,
} from './dto'
import type { BrowserProfileSettings } from '../config/types'

export interface BroadcastEventMap {
  // Session events (workspace-scoped via broadcastToWorkspace)
  [RPC_NAMESPACES.sessions.EVENT]: [event: SessionEvent]
  [RPC_NAMESPACES.sessions.UNREAD_SUMMARY_CHANGED]: [summary: UnreadSummary]
  [RPC_NAMESPACES.sessions.FILES_CHANGED]: [sessionId: string]

  // Domain change broadcasts (global via broadcastToAll)
  [RPC_NAMESPACES.sources.CHANGED]: [workspaceId: string, sources: PublicSourceDto[]]
  [RPC_NAMESPACES.labels.CHANGED]: [workspaceId: string]
  [RPC_NAMESPACES.channels.CHANGED]: [workspaceId: string]
  [RPC_NAMESPACES.channels.MESSAGES_CHANGED]: [workspaceId: string, channelId: string]
  [RPC_NAMESPACES.statuses.CHANGED]: [workspaceId: string]
  [RPC_NAMESPACES.automations.CHANGED]: [workspaceId: string]
  [RPC_NAMESPACES.skills.CHANGED]: [workspaceId: string, skills: LoadedSkill[]]
  [RPC_NAMESPACES.projects.CHANGED]: [workspaceId: string, projects: LoadedProject[]]
  [RPC_NAMESPACES.tasks.GENERATED]: [workspaceId: string, result: TaskGenerateResult]
  [RPC_NAMESPACES.llmConnections.CHANGED]: []
  [RPC_NAMESPACES.permissions.DEFAULTS_CHANGED]: [value: null]

  // Theme broadcasts (global)
  [RPC_NAMESPACES.theme.APP_CHANGED]: [theme: ThemeOverrides | null]
  [RPC_NAMESPACES.theme.SYSTEM_CHANGED]: [isDark: boolean]
  [RPC_NAMESPACES.theme.PREFERENCES_CHANGED]: [preferences: { mode: string; colorTheme: string; font: string }]
  [RPC_NAMESPACES.theme.WORKSPACE_THEME_CHANGED]: [data: { workspaceId: string; themeId: string | null }]

  // Update broadcasts (global)
  [RPC_NAMESPACES.update.AVAILABLE]: [info: UpdateInfo]
  [RPC_NAMESPACES.update.DOWNLOAD_PROGRESS]: [progress: number]

  // Badge broadcasts (global)
  [RPC_NAMESPACES.badge.DRAW]: [data: { count: number; iconDataUrl: string }]
  [RPC_NAMESPACES.badge.DRAW_WINDOWS]: [data: { count: number }]

  // Window events (per-window)
  [RPC_NAMESPACES.window.FOCUS_STATE]: [isFocused: boolean]
  [RPC_NAMESPACES.window.CLOSE_REQUESTED]: []

  // Browser pane events (global)
  [RPC_NAMESPACES.browserPane.STATE_CHANGED]: [info: BrowserInstanceInfo]
  [RPC_NAMESPACES.browserPane.REMOVED]: [id: string]
  [RPC_NAMESPACES.browserPane.INTERACTED]: [id: string]
  [RPC_NAMESPACES.browserPane.PROFILES_CHANGED]: [settings: BrowserProfileSettings]
  [RPC_NAMESPACES.browserPane.PICKER_REQUESTED]: [data: { instanceId: string }]
  [RPC_NAMESPACES.browserPane.DISPLAY_MODE_REQUESTED]: [data: { instanceId: string; mode: 'floating' | 'integrated' }]

  // Navigation events (per-window)
  [RPC_NAMESPACES.notification.NAVIGATE]: [data: { workspaceId: string; sessionId: string }]
  [RPC_NAMESPACES.deeplink.NAVIGATE]: [navigation: DeepLinkNavigation]

  // Copilot device code event
  [RPC_NAMESPACES.copilot.DEVICE_CODE]: [data: { userCode: string; verificationUri: string }]

  // Menu events (per-window, no payload)
  [RPC_NAMESPACES.menu.NEW_CHAT]: []
  [RPC_NAMESPACES.menu.OPEN_SETTINGS]: []
  [RPC_NAMESPACES.menu.KEYBOARD_SHORTCUTS]: []
  [RPC_NAMESPACES.menu.TOGGLE_FOCUS_MODE]: []
  [RPC_NAMESPACES.menu.TOGGLE_SIDEBAR]: []

  // Messaging gateway broadcasts
  [RPC_NAMESPACES.messaging.BINDING_CHANGED]: [workspaceId: string]
  [RPC_NAMESPACES.messaging.PLATFORM_STATUS]: [workspaceId: string, platform: string, connected: boolean]
}
