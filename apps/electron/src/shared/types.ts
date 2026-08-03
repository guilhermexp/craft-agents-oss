// =============================================================================
// Protocol re-exports (channels, DTOs, events, wire types)
// =============================================================================
export * from '@craft-agent/shared/protocol'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { CreateProjectInput, ProjectConfig, ProjectAsset } from '@craft-agent/shared/projects/types'
import type { LabelConfig, CreateLabelInput } from '@craft-agent/shared/labels'
import type { PermissionsConfigFile } from '@craft-agent/shared/agent'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import type { StatusConfig } from '@craft-agent/shared/statuses'
import type { ThemeOverrides, PresetTheme } from '@config/theme'
import type { ViewConfig } from '@craft-agent/shared/views'
import type { WarRoomChannel, CreateWarRoomChannelInput, UpdateWarRoomChannelInput, DeleteChannelOptions, DeleteChannelResult, ChannelMessage, WarRoomDispatch } from '@craft-agent/shared/channels'
import { WORKSPACE_OBJECT_RPC_CHANNELS, type WorkspaceObjectEvent, type WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'
import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'

// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================

// Core types
import type {
  Message as CoreMessage,
  MessageRole as CoreMessageRole,
  TypedError,
  TokenUsage as CoreTokenUsage,
  WorkspaceInfo as CoreWorkspaceInfo,
  Workspace as CoreWorkspace,
  SessionMetadata as CoreSessionMetadata,
  StoredAttachment as CoreStoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
} from '@craft-agent/core/types';

// Mode types from dedicated subpath export (avoids pulling in SDK)
import type { PermissionMode } from '@craft-agent/shared/agent/modes';
export type { PermissionMode };
export { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/modes';

// Thinking level types
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
export type { ThinkingLevel };
export { THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';

export type {
  CoreMessage as Message,
  CoreMessageRole as MessageRole,
  TypedError,
  CoreTokenUsage as TokenUsage,
  CoreWorkspaceInfo as WorkspaceInfo,
  CoreWorkspace as Workspace,
  CoreSessionMetadata as SessionMetadata,
  CoreStoredAttachment as StoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
};

// Auth types for onboarding
import type { AuthState, SetupNeeds } from '@craft-agent/shared/auth/types';
import type { AuthType, BrowserProfile, BrowserProfileSettings } from '@craft-agent/shared/config/types';
import type { BrowserProfileInput } from '@craft-agent/shared/config/browser-profiles';
export type { AuthState, SetupNeeds, AuthType };

// Credential health types
import type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType } from '@craft-agent/shared/credentials/types';
export type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType };

// Source types for session source selection
import type { LoadedSource, FolderSourceConfig, SourceConnectionStatus } from '@craft-agent/shared/sources/types';
import type { PublicSourceDto } from '@craft-agent/shared/sources/public-source-dto';
import type { ComposioCatalogItem } from '@craft-agent/shared/sources/composio-catalog';
export type { LoadedSource, FolderSourceConfig, PublicSourceDto, SourceConnectionStatus };
export type { ComposioCatalogItem };

// Skill types
import type { LoadedSkill, SkillMetadata } from '@craft-agent/shared/skills/types';
export type { LoadedSkill, SkillMetadata };

// Resource bundle types (cross-workspace export/import)
import type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult } from '@craft-agent/shared/resources';
export type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult };

// LLM connection types
import type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings, SessionDraft } from '@craft-agent/shared/config';
export type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings };

// =============================================================================
// GUI-only types (not used by server/handler code)
// =============================================================================

/** Tool icon mapping entry from tool-icons.json (with icon resolved to data URL) */
export interface ToolIconMapping {
  id: string
  displayName: string
  /** Data URL of the icon (e.g., data:image/png;base64,...) */
  iconDataUrl: string
  commands: string[]
}

/**
 * Browser pane creation options
 */
export interface BrowserPaneCreateOptions {
  id?: string
  show?: boolean
  bindToSessionId?: string
  /** Initial URL to load before the window is shown. Avoids create+navigate races. */
  url?: string
  /** Browser profile id — controls session partition isolation (cookies/storage). */
  profileId?: string
}

/**
 * Empty-state launch request from the browser empty-state renderer.
 */
export interface BrowserEmptyStateLaunchPayload {
  route: string
  token?: string
}

/**
 * Result of browser empty-state launch handling.
 */
export interface BrowserEmptyStateLaunchResult {
  ok: boolean
  handled: boolean
  reason?: string
}

export type TransportMode = 'local' | 'remote'

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  updatedAt: number
}

// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================

// Re-import types for ElectronAPI
import type { WorkspaceInfo, Workspace, SessionMetadata, StoredAttachment as StoredAttachmentType } from '@craft-agent/core/types';

// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type {
  Session,
  UnreadSummary,
  CreateSessionOptions,
  TaskValidationResultDto,
  TaskCreateRequest,
  TaskCreateResult,
  TaskGenerateRequest,
  TaskGenerateAck,
  TaskGenerateResult,
  TaskRunRequest,
  TaskRunSnapshotDto,
  TaskGetResult,
  TaskResultsDto,
  FileAttachment,
  SendMessageOptions,
  SessionEvent,
  PermissionResponseOptions,
  CredentialResponse,
  AskUserQuestionResponse,
  SessionCommand,
  ShareResult,
  RefreshTitleResult,
  FileSearchResult,
  SessionSearchResult,
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  SkillFile,
  SessionFile,
  OAuthResult,
  McpToolsResult,
  GitBashStatus,
  ClaudeOAuthResult,
  UpdateInfo,
  WorkspaceSettings,
  PermissionModeState,
  BrowserInstanceInfo,
  DeepLinkNavigation,
  TestAutomationPayload,
  TestAutomationResult,
  WindowCloseRequest,
  DirectoryListingResult,
  FileTreeListingResult,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
  HermesDetectionResult,
  HermesDashboardResult,
  HermesRuntimeDetailsResult,
  HermesUpdateResult,
  HermesListLogsResult,
  HermesReadLogResult,
  HermesListHomeFilesResult,
  HermesListSkillsResult,
  HermesOpenPathResult,
  HermesActiveProfileResult,
  HermesListProfilesResult,
  HermesProfileMutationResult,
  HermesProfileSetupCommandResult,
  HermesProfileSoulResult,
  HermesListEnvResult,
  HermesEnvMutationResult,
  MeetingTranscriptionConfig,
  MeetingRecord,
  MeetingStartInput,
  MeetingTranscriptResult,
  SaveMeetingTranscriptionConfigInput,
} from '@craft-agent/shared/protocol'


// =============================================================================
// RPC contract — single source of truth for ElectronAPI + CHANNEL_MAP
// =============================================================================
// Each leaf declares its wire channel (referencing RPC_NAMESPACES) plus a phantom
// signature. ElectronAPI (below) and CHANNEL_MAP (transport/channel-map.ts) are
// both DERIVED from this object — a new RPC method is a single contract entry.
//   invoke  — request/response over the RPC transport
//   event   — server→client push the renderer subscribes to (listener)
//   local   — never crosses the RPC channel map; attached by the preload / web
//             adapter / build-api (e.g. performOAuth, getFilePath, getSetupNeeds)

export type RpcLeafKind = 'invoke' | 'event' | 'local'

/** Phantom carrier for the ElectronAPI signature — never present at runtime. */
interface LeafSig<Sig> { readonly __sig?: Sig }
interface InvokeLeaf<Sig> extends LeafSig<Sig> { readonly kind: 'invoke'; readonly channel: string }
interface EventLeaf<Sig> extends LeafSig<Sig> { readonly kind: 'event'; readonly channel: string }
interface LocalLeaf<Sig> extends LeafSig<Sig> { readonly kind: 'local' }

// Discriminated union: only `invoke`/`event` leaves carry a wire channel, so the
// derivations below read `leaf.channel` without a non-null assertion, and the
// `satisfies` guard rejects a channel-less `invoke`/`event` entry.
export type RpcLeaf<K extends RpcLeafKind, Sig> =
  K extends 'invoke' ? InvokeLeaf<Sig>
  : K extends 'event' ? EventLeaf<Sig>
  : LocalLeaf<Sig>

function invoke<Sig>(channel: string): RpcLeaf<'invoke', Sig> {
  return { kind: 'invoke', channel }
}
function event<Sig>(channel: string): RpcLeaf<'event', Sig> {
  return { kind: 'event', channel }
}
function local<Sig>(): RpcLeaf<'local', Sig> {
  return { kind: 'local' }
}

export const RPC_CONTRACT = {
  getSessions: invoke<(() => Promise<Session[]>)>(RPC_NAMESPACES.sessions.GET),
  getUnreadSummary: invoke<(() => Promise<UnreadSummary>)>(RPC_NAMESPACES.sessions.GET_UNREAD_SUMMARY),
  markAllSessionsRead: invoke<((workspaceId: string) => Promise<void>)>(RPC_NAMESPACES.sessions.MARK_ALL_READ),
  getSessionMessages: invoke<((sessionId: string) => Promise<Session | null>)>(RPC_NAMESPACES.sessions.GET_MESSAGES),
  createSession: invoke<((workspaceId: string, options?: CreateSessionOptions) => Promise<Session>)>(RPC_NAMESPACES.sessions.CREATE),
  deleteSession: invoke<((sessionId: string) => Promise<void>)>(RPC_NAMESPACES.sessions.DELETE),
  sendMessage: invoke<((sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachmentType[], options?: SendMessageOptions) => Promise<void>)>(RPC_NAMESPACES.sessions.SEND_MESSAGE),
  cancelProcessing: invoke<((sessionId: string, silent?: boolean) => Promise<void>)>(RPC_NAMESPACES.sessions.CANCEL),
  killShell: invoke<((sessionId: string, shellId: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.sessions.KILL_SHELL),
  getTaskOutput: invoke<((taskId: string) => Promise<string | null>)>(RPC_NAMESPACES.tasks.GET_OUTPUT),
  validateTask: invoke<((workspaceId: string, yaml: string) => Promise<TaskValidationResultDto>)>(RPC_NAMESPACES.tasks.VALIDATE),
  createTask: invoke<((workspaceId: string, req: TaskCreateRequest) => Promise<TaskCreateResult>)>(RPC_NAMESPACES.tasks.CREATE),
  generateTask: invoke<((workspaceId: string, req: TaskGenerateRequest) => Promise<TaskGenerateAck>)>(RPC_NAMESPACES.tasks.GENERATE),
  /** Async generate result (or error), keyed by orchestratorSessionId. Subscribe before/after generateTask. */
  onTaskGenerated: event<((callback: (workspaceId: string, result: TaskGenerateResult) => void) => () => void)>(RPC_NAMESPACES.tasks.GENERATED),
  runTask: invoke<((workspaceId: string, req: TaskRunRequest) => Promise<TaskRunSnapshotDto>)>(RPC_NAMESPACES.tasks.RUN),
  pauseTask: invoke<((workspaceId: string, slug: string, runId: string) => Promise<void>)>(RPC_NAMESPACES.tasks.PAUSE),
  resumeTask: invoke<((workspaceId: string, slug: string, runId: string) => Promise<void>)>(RPC_NAMESPACES.tasks.RESUME),
  stopTask: invoke<((workspaceId: string, slug: string, runId: string) => Promise<void>)>(RPC_NAMESPACES.tasks.STOP),
  getTask: invoke<((workspaceId: string, slug: string, runId?: string) => Promise<TaskGetResult>)>(RPC_NAMESPACES.tasks.GET),
  listTasks: invoke<((workspaceId: string) => Promise<string[]>)>(RPC_NAMESPACES.tasks.LIST),
  getTaskResults: invoke<((workspaceId: string, slug: string, runId?: string) => Promise<TaskResultsDto>)>(RPC_NAMESPACES.tasks.GET_RESULTS),
  respondToPermission: invoke<((sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: PermissionResponseOptions) => Promise<boolean>)>(RPC_NAMESPACES.sessions.RESPOND_TO_PERMISSION),
  respondToCredential: invoke<((sessionId: string, requestId: string, response: CredentialResponse) => Promise<boolean>)>(RPC_NAMESPACES.sessions.RESPOND_TO_CREDENTIAL),
  respondToUserQuestion: invoke<((sessionId: string, requestId: string, response: AskUserQuestionResponse) => Promise<boolean>)>(RPC_NAMESPACES.sessions.RESPOND_TO_USER_QUESTION),
  sessionCommand: invoke<((sessionId: string, command: SessionCommand) => Promise<void | ShareResult | RefreshTitleResult | { count: number }>)>(RPC_NAMESPACES.sessions.COMMAND),
  getServerHomeDir: invoke<(() => Promise<string>)>(RPC_NAMESPACES.server.HOME_DIR),
  getServerConfig: invoke<(() => Promise<ServerConfig>)>(RPC_NAMESPACES.settings.GET_SERVER_CONFIG),
  setServerConfig: invoke<((config: ServerConfig) => Promise<void>)>(RPC_NAMESPACES.settings.SET_SERVER_CONFIG),
  getServerStatus: invoke<(() => Promise<ServerStatus>)>(RPC_NAMESPACES.settings.GET_SERVER_STATUS),
  relaunchApp: local<(() => Promise<void>)>(),
  removeWorkspace: local<((workspaceId: string) => Promise<boolean>)>(),
  invokeOnServer: local<((url: string, token: string, channel: string, ...args: any[]) => Promise<any>)>(),
  transferSessionToWorkspace: local<((sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => Promise<{ sessionId: string }>)>(),
  onTransferProgress: local<((callback: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => () => void)>(),
  exportSession: invoke<((sessionId: string) => Promise<unknown>)>(RPC_NAMESPACES.sessions.EXPORT),
  importSession: invoke<((targetWorkspaceId: string, bundle: unknown, mode: 'move' | 'fork') => Promise<{ sessionId: string; warnings?: string[] }>)>(RPC_NAMESPACES.sessions.IMPORT),
  exportRemoteSessionTransfer: invoke<((sessionId: string) => Promise<RemoteSessionTransferPayload>)>(RPC_NAMESPACES.sessions.EXPORT_REMOTE_TRANSFER),
  importRemoteSessionTransfer: invoke<((targetWorkspaceId: string, payload: RemoteSessionTransferPayload) => Promise<ImportRemoteSessionTransferResult>)>(RPC_NAMESPACES.sessions.IMPORT_REMOTE_TRANSFER),
  getPendingPlanExecution: invoke<((sessionId: string) => Promise<{ planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null>)>(RPC_NAMESPACES.sessions.GET_PENDING_PLAN_EXECUTION),
  getSessionPermissionModeState: invoke<((sessionId: string) => Promise<PermissionModeState | null>)>(RPC_NAMESPACES.sessions.GET_PERMISSION_MODE_STATE),
  getWorkspaces: invoke<(() => Promise<Workspace[]>)>(RPC_NAMESPACES.workspaces.GET),
  listWorkspaceObjects: invoke<((workspaceId: string) => Promise<{ objects: WorkspaceObjectPayload[] }>)>(WORKSPACE_OBJECT_RPC_CHANNELS.LIST),
  executeWorkspaceObjectAction: invoke<((workspaceId: string, input: WorkspaceObjectAction) => Promise<WorkspaceObjectServiceResult>)>(WORKSPACE_OBJECT_RPC_CHANNELS.EXECUTE),
  subscribeWorkspaceObjects: invoke<((workspaceId: string) => Promise<void>)>(WORKSPACE_OBJECT_RPC_CHANNELS.SUBSCRIBE),
  unsubscribeWorkspaceObjects: invoke<((workspaceId: string) => Promise<void>)>(WORKSPACE_OBJECT_RPC_CHANNELS.UNSUBSCRIBE),
  onWorkspaceObjectEvent: event<((callback: (event: WorkspaceObjectEvent) => void) => () => void)>(WORKSPACE_OBJECT_RPC_CHANNELS.EVENT),
  createWorkspace: invoke<((folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }) => Promise<Workspace>)>(RPC_NAMESPACES.workspaces.CREATE),
  checkWorkspaceSlug: invoke<((slug: string) => Promise<{ exists: boolean; path: string }>)>(RPC_NAMESPACES.workspaces.CHECK_SLUG),
  updateWorkspaceRemoteServer: invoke<((workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.workspaces.UPDATE_REMOTE),
  getDefaultWorkspaceId: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.workspaces.GET_DEFAULT),
  setDefaultWorkspace: invoke<((workspaceId: string | null) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.workspaces.SET_DEFAULT),
  getServerWorkspaces: invoke<(() => Promise<WorkspaceInfo[]>)>(RPC_NAMESPACES.server.GET_WORKSPACES),
  createServerWorkspace: invoke<((name: string) => Promise<WorkspaceInfo>)>(RPC_NAMESPACES.server.CREATE_WORKSPACE),
  testRemoteConnection: invoke<((url: string, token: string) => Promise<{
    ok: boolean
    error?: string
    needsWorkspace?: boolean
    remoteWorkspaces?: Array<{ id: string; name: string }>
    remoteWorkspaceId?: string   // auto-set when exactly one workspace
    remoteWorkspaceName?: string // auto-set when exactly one workspace
    serverVersion?: string       // server app version from handshake
  }>)>(RPC_NAMESPACES.remote.TEST_CONNECTION),
  getWindowWorkspace: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.window.GET_WORKSPACE),
  getWindowMode: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.window.GET_MODE),
  openWorkspace: invoke<((workspaceId: string) => Promise<void>)>(RPC_NAMESPACES.window.OPEN_WORKSPACE),
  openSessionInNewWindow: invoke<((workspaceId: string, sessionId: string) => Promise<void>)>(RPC_NAMESPACES.window.OPEN_SESSION_IN_NEW_WINDOW),
  switchWorkspace: invoke<((workspaceId: string) => Promise<void>)>(RPC_NAMESPACES.window.SWITCH_WORKSPACE),
  closeWindow: invoke<(() => Promise<void>)>(RPC_NAMESPACES.window.CLOSE),
  confirmCloseWindow: invoke<(() => Promise<void>)>(RPC_NAMESPACES.window.CONFIRM_CLOSE),
  /** Cancel a pending close request (renderer handled it by closing a modal/panel). */
  cancelCloseWindow: invoke<(() => Promise<void>)>(RPC_NAMESPACES.window.CANCEL_CLOSE),
  /** Listen for close requests and receive source metadata. Returns cleanup function. */
  onCloseRequested: event<((callback: (request: WindowCloseRequest) => void) => () => void)>(RPC_NAMESPACES.window.CLOSE_REQUESTED),
  /** Show/hide macOS traffic light buttons (for fullscreen overlays) */
  setTrafficLightsVisible: invoke<((visible: boolean) => Promise<void>)>(RPC_NAMESPACES.window.SET_TRAFFIC_LIGHTS),
  onSessionEvent: event<((callback: (event: SessionEvent) => void) => () => void)>(RPC_NAMESPACES.sessions.EVENT),
  onUnreadSummaryChanged: event<((callback: (summary: UnreadSummary) => void) => () => void)>(RPC_NAMESPACES.sessions.UNREAD_SUMMARY_CHANGED),
  readFile: invoke<((path: string) => Promise<string>)>(RPC_NAMESPACES.file.READ),
  /** Read a file as binary data (Uint8Array) */
  readFileBinary: invoke<((path: string) => Promise<Uint8Array>)>(RPC_NAMESPACES.file.READ_BINARY),
  /** Read a file as a data URL (data:{mime};base64,...) for binary preview (images, PDFs) */
  readFileDataUrl: invoke<((path: string) => Promise<string>)>(RPC_NAMESPACES.file.READ_DATA_URL),
  /** Read an image file as a size-bounded preview data URL for lightweight thumbnail rendering. */
  readFilePreviewDataUrl: invoke<((path: string, maxSize?: number) => Promise<string>)>(RPC_NAMESPACES.file.READ_PREVIEW_DATA_URL),
  openFileDialog: invoke<(() => Promise<string[]>)>(RPC_NAMESPACES.file.OPEN_DIALOG),
  readFileAttachment: invoke<((path: string) => Promise<FileAttachment | null>)>(RPC_NAMESPACES.file.READ_ATTACHMENT),
  /** Re-read a user-attached file by absolute path (bypasses workspace-dir validation).
   *  Used only by draft hydration for paths the user explicitly picked via OS dialog / drag. */
  readUserAttachment: invoke<((path: string) => Promise<FileAttachment | null>)>(RPC_NAMESPACES.file.READ_USER_ATTACHMENT),
  storeAttachment: invoke<((sessionId: string, attachment: FileAttachment) => Promise<StoredAttachmentType>)>(RPC_NAMESPACES.file.STORE_ATTACHMENT),
  generateThumbnail: invoke<((base64: string, mimeType: string) => Promise<string | null>)>(RPC_NAMESPACES.file.GENERATE_THUMBNAIL),
  /** Returns the absolute filesystem path for a File (only works for file-picker / OS-drag Files). */
  getFilePath: local<((file: File) => string | null)>(),
  searchFiles: invoke<((basePath: string, query: string) => Promise<FileSearchResult[]>)>(RPC_NAMESPACES.fs.SEARCH),
  listServerDirectory: invoke<((dirPath: string) => Promise<DirectoryListingResult>)>(RPC_NAMESPACES.fs.LIST_DIRECTORY),
  listFileTree: invoke<((rootPath?: string, dirPath?: string) => Promise<FileTreeListingResult>)>(RPC_NAMESPACES.fs.LIST_TREE),
  debugLog: invoke<((...args: unknown[]) => void)>(RPC_NAMESPACES.debug.LOG),
  getSystemTheme: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.theme.GET_SYSTEM_PREFERENCE),
  onSystemThemeChange: event<((callback: (isDark: boolean) => void) => () => void)>(RPC_NAMESPACES.theme.SYSTEM_CHANGED),
  getVersions: invoke<(() => { node: string; chrome: string; electron: string })>(RPC_NAMESPACES.system.VERSIONS),
  /** Returns the renderer host environment without going through RPC. */
  getRuntimeEnvironment: local<(() => 'electron' | 'web')>(),
  getHomeDir: invoke<(() => Promise<string>)>(RPC_NAMESPACES.system.HOME_DIR),
  isDebugMode: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.system.IS_DEBUG_MODE),
  getTransportConnectionState: local<(() => Promise<TransportConnectionState>)>(),
  onTransportConnectionStateChanged: local<((callback: (state: TransportConnectionState) => void) => () => void)>(),
  reconnectTransport: local<(() => Promise<void>)>(),
  /** Fired after a WebSocket reconnect. isStale=true means buffer was evicted — full refresh needed. */
  onReconnected: event<((callback: (isStale: boolean) => void) => () => void)>('__transport:reconnected'),
  /** Check whether the server registered a handler for a given RPC channel. */
  isChannelAvailable: local<((channel: string) => boolean)>(),
  checkForUpdates: invoke<(() => Promise<UpdateInfo>)>(RPC_NAMESPACES.update.CHECK),
  getUpdateInfo: invoke<(() => Promise<UpdateInfo>)>(RPC_NAMESPACES.update.GET_INFO),
  installUpdate: invoke<(() => Promise<void>)>(RPC_NAMESPACES.update.INSTALL),
  dismissUpdate: invoke<((version: string) => Promise<void>)>(RPC_NAMESPACES.update.DISMISS),
  getDismissedUpdateVersion: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.update.GET_DISMISSED),
  onUpdateAvailable: event<((callback: (info: UpdateInfo) => void) => () => void)>(RPC_NAMESPACES.update.AVAILABLE),
  onUpdateDownloadProgress: event<((callback: (progress: number) => void) => () => void)>(RPC_NAMESPACES.update.DOWNLOAD_PROGRESS),
  getReleaseNotes: invoke<(() => Promise<string>)>(RPC_NAMESPACES.releaseNotes.GET),
  getLatestReleaseVersion: invoke<(() => Promise<string | undefined>)>(RPC_NAMESPACES.releaseNotes.GET_LATEST_VERSION),
  getSystemWarnings: local<(() => Promise<{ vcredistMissing: boolean; downloadUrl?: string }>)>(),
  openUrl: invoke<((url: string) => Promise<void>)>(RPC_NAMESPACES.shell.OPEN_URL),
  openFile: invoke<((path: string) => Promise<void>)>(RPC_NAMESPACES.shell.OPEN_FILE),
  showInFolder: invoke<((path: string) => Promise<void>)>(RPC_NAMESPACES.shell.SHOW_IN_FOLDER),
  onMenuNewChat: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.menu.NEW_CHAT),
  onMenuOpenSettings: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.menu.OPEN_SETTINGS),
  onMenuKeyboardShortcuts: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.menu.KEYBOARD_SHORTCUTS),
  onMenuToggleFocusMode: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.menu.TOGGLE_FOCUS_MODE),
  onMenuToggleSidebar: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.menu.TOGGLE_SIDEBAR),
  onDeepLinkNavigate: event<((callback: (nav: DeepLinkNavigation) => void) => () => void)>(RPC_NAMESPACES.deeplink.NAVIGATE),
  showLogoutConfirmation: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.auth.SHOW_LOGOUT_CONFIRMATION),
  showDeleteSessionConfirmation: invoke<((name: string) => Promise<boolean>)>(RPC_NAMESPACES.auth.SHOW_DELETE_SESSION_CONFIRMATION),
  logout: invoke<(() => Promise<void>)>(RPC_NAMESPACES.auth.LOGOUT),
  getCredentialHealth: invoke<(() => Promise<CredentialHealthStatus>)>(RPC_NAMESPACES.credentials.HEALTH_CHECK),
  getAuthState: invoke<(() => Promise<AuthState>)>(RPC_NAMESPACES.onboarding.GET_AUTH_STATE),
  getSetupNeeds: local<(() => Promise<SetupNeeds>)>(),
  startWorkspaceMcpOAuth: invoke<((mcpUrl: string) => Promise<OAuthResult & { clientId?: string }>)>(RPC_NAMESPACES.onboarding.START_MCP_OAUTH),
  startClaudeOAuth: invoke<(() => Promise<{ success: boolean; authUrl?: string; error?: string }>)>(RPC_NAMESPACES.onboarding.START_CLAUDE_OAUTH),
  exchangeClaudeCode: invoke<((code: string, connectionSlug: string) => Promise<ClaudeOAuthResult>)>(RPC_NAMESPACES.onboarding.EXCHANGE_CLAUDE_CODE),
  hasClaudeOAuthState: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.onboarding.HAS_CLAUDE_OAUTH_STATE),
  clearClaudeOAuthState: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.onboarding.CLEAR_CLAUDE_OAUTH_STATE),
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.onboarding.DEFER_SETUP),
  startChatGptOAuth: invoke<((connectionSlug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.chatgpt.START_OAUTH),
  cancelChatGptOAuth: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.chatgpt.CANCEL_OAUTH),
  getChatGptAuthStatus: invoke<((connectionSlug: string) => Promise<{ authenticated: boolean; expiresAt?: number; hasRefreshToken?: boolean }>)>(RPC_NAMESPACES.chatgpt.GET_AUTH_STATUS),
  chatGptLogout: invoke<((connectionSlug: string) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.chatgpt.LOGOUT),
  startCopilotOAuth: invoke<((connectionSlug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.copilot.START_OAUTH),
  cancelCopilotOAuth: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.copilot.CANCEL_OAUTH),
  getCopilotAuthStatus: invoke<((connectionSlug: string) => Promise<{ authenticated: boolean }>)>(RPC_NAMESPACES.copilot.GET_AUTH_STATUS),
  copilotLogout: invoke<((connectionSlug: string) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.copilot.LOGOUT),
  onCopilotDeviceCode: event<((callback: (data: { userCode: string; verificationUri: string }) => void) => () => void)>(RPC_NAMESPACES.copilot.DEVICE_CODE),
  /** Unified LLM connection setup */
  setupLlmConnection: invoke<((setup: LlmConnectionSetup) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.settings.SETUP_LLM_CONNECTION),
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup: invoke<((params: TestLlmConnectionParams) => Promise<TestLlmConnectionResult>)>(RPC_NAMESPACES.settings.TEST_LLM_CONNECTION_SETUP),
  getPiApiKeyProviders: invoke<(() => Promise<Array<{ key: string; label: string; placeholder: string }>>)>(RPC_NAMESPACES.pi.GET_API_KEY_PROVIDERS),
  getPiProviderBaseUrl: invoke<((provider: string) => Promise<string | undefined>)>(RPC_NAMESPACES.pi.GET_PROVIDER_BASE_URL),
  getPiProviderModels: invoke<((provider: string) => Promise<{ models: Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>; totalCount: number }>)>(RPC_NAMESPACES.pi.GET_PROVIDER_MODELS),
  detectHermesInstallation: invoke<(() => Promise<HermesDetectionResult>)>(RPC_NAMESPACES.hermes.DETECT_INSTALLATION),
  getHermesRuntimeDetails: invoke<(() => Promise<HermesRuntimeDetailsResult>)>(RPC_NAMESPACES.hermes.GET_RUNTIME_DETAILS),
  startHermesDashboard: invoke<(() => Promise<HermesDashboardResult>)>(RPC_NAMESPACES.hermes.START_DASHBOARD),
  updateHermesRuntime: invoke<(() => Promise<HermesUpdateResult>)>(RPC_NAMESPACES.hermes.UPDATE_RUNTIME),
  listHermesLogs: invoke<(() => Promise<HermesListLogsResult>)>(RPC_NAMESPACES.hermes.LIST_LOGS),
  readHermesLog: invoke<((name: string) => Promise<HermesReadLogResult>)>(RPC_NAMESPACES.hermes.READ_LOG),
  listHermesHomeFiles: invoke<((target?: string) => Promise<HermesListHomeFilesResult>)>(RPC_NAMESPACES.hermes.LIST_HOME_FILES),
  listHermesSkills: invoke<(() => Promise<HermesListSkillsResult>)>(RPC_NAMESPACES.hermes.LIST_SKILLS),
  openHermesPath: invoke<((target?: string) => Promise<HermesOpenPathResult>)>(RPC_NAMESPACES.hermes.OPEN_PATH),
  getHermesApiConfig: invoke<(() => Promise<{ success: true; data: unknown } | { success: false; error: string }>)>(RPC_NAMESPACES.hermes.GET_API_CONFIG),
  patchHermesApiConfig: invoke<((body: { config?: Record<string, unknown>; env?: Record<string, string> }) => Promise<{ success: true; data: unknown } | { success: false; error: string }>)>(RPC_NAMESPACES.hermes.PATCH_API_CONFIG),
  getHermesProviderModels: invoke<((provider: string) => Promise<{ success: true; data: unknown } | { success: false; error: string }>)>(RPC_NAMESPACES.hermes.GET_PROVIDER_MODELS),
  listHermesProfiles: invoke<(() => Promise<HermesListProfilesResult>)>(RPC_NAMESPACES.hermes.LIST_PROFILES),
  getActiveHermesProfile: invoke<(() => Promise<HermesActiveProfileResult>)>(RPC_NAMESPACES.hermes.GET_ACTIVE_PROFILE),
  setActiveHermesProfile: invoke<((name: string) => Promise<HermesActiveProfileResult>)>(RPC_NAMESPACES.hermes.SET_ACTIVE_PROFILE),
  createHermesProfile: invoke<((body: { name: string; cloneFromDefault: boolean }) => Promise<HermesProfileMutationResult>)>(RPC_NAMESPACES.hermes.CREATE_PROFILE),
  renameHermesProfile: invoke<((name: string, newName: string) => Promise<HermesProfileMutationResult>)>(RPC_NAMESPACES.hermes.RENAME_PROFILE),
  deleteHermesProfile: invoke<((name: string) => Promise<HermesProfileMutationResult>)>(RPC_NAMESPACES.hermes.DELETE_PROFILE),
  getHermesProfileSetupCommand: invoke<((name: string) => Promise<HermesProfileSetupCommandResult>)>(RPC_NAMESPACES.hermes.GET_PROFILE_SETUP_COMMAND),
  getHermesProfileSoul: invoke<((name: string) => Promise<HermesProfileSoulResult>)>(RPC_NAMESPACES.hermes.GET_PROFILE_SOUL),
  updateHermesProfileSoul: invoke<((name: string, content: string) => Promise<HermesProfileMutationResult>)>(RPC_NAMESPACES.hermes.UPDATE_PROFILE_SOUL),
  listHermesEnv: invoke<(() => Promise<HermesListEnvResult>)>(RPC_NAMESPACES.hermes.LIST_ENV),
  setHermesEnv: invoke<((body: { key: string; value: string }) => Promise<HermesEnvMutationResult>)>(RPC_NAMESPACES.hermes.SET_ENV),
  deleteHermesEnv: invoke<((key: string) => Promise<HermesEnvMutationResult>)>(RPC_NAMESPACES.hermes.DELETE_ENV),
  getSessionModel: invoke<((sessionId: string, workspaceId: string) => Promise<string | null>)>(RPC_NAMESPACES.sessions.GET_MODEL),
  setSessionModel: invoke<((sessionId: string, workspaceId: string, model: string | null, connection?: string) => Promise<void>)>(RPC_NAMESPACES.sessions.SET_MODEL),
  getWorkspaceSettings: invoke<((workspaceId: string) => Promise<WorkspaceSettings | null>)>(RPC_NAMESPACES.workspace.SETTINGS_GET),
  updateWorkspaceSetting: invoke<(<K extends keyof WorkspaceSettings>(workspaceId: string, key: K, value: WorkspaceSettings[K]) => Promise<void>)>(RPC_NAMESPACES.workspace.SETTINGS_UPDATE),
  openFolderDialog: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.dialog.OPEN_FOLDER),
  readPreferences: invoke<(() => Promise<{ content: string; exists: boolean; path: string }>)>(RPC_NAMESPACES.preferences.READ),
  writePreferences: invoke<((content: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.preferences.WRITE),
  getDraft: invoke<((sessionId: string) => Promise<SessionDraft | null>)>(RPC_NAMESPACES.drafts.GET),
  setDraft: invoke<((sessionId: string, draft: SessionDraft) => Promise<void>)>(RPC_NAMESPACES.drafts.SET),
  deleteDraft: invoke<((sessionId: string) => Promise<void>)>(RPC_NAMESPACES.drafts.DELETE),
  getAllDrafts: invoke<(() => Promise<Record<string, SessionDraft>>)>(RPC_NAMESPACES.drafts.GET_ALL),
  getSessionFiles: invoke<((sessionId: string) => Promise<SessionFile[]>)>(RPC_NAMESPACES.sessions.GET_FILES),
  getSessionNotes: invoke<((sessionId: string) => Promise<string>)>(RPC_NAMESPACES.sessions.GET_NOTES),
  setSessionNotes: invoke<((sessionId: string, content: string) => Promise<void>)>(RPC_NAMESPACES.sessions.SET_NOTES),
  watchSessionFiles: invoke<((sessionId: string) => Promise<void>)>(RPC_NAMESPACES.sessions.WATCH_FILES),
  unwatchSessionFiles: invoke<(() => Promise<void>)>(RPC_NAMESPACES.sessions.UNWATCH_FILES),
  onSessionFilesChanged: event<((callback: (sessionId: string) => void) => () => void)>(RPC_NAMESPACES.sessions.FILES_CHANGED),
  getSources: invoke<((workspaceId: string) => Promise<PublicSourceDto[]>)>(RPC_NAMESPACES.sources.GET),
  createSource: invoke<((workspaceId: string, config: Partial<FolderSourceConfig>) => Promise<PublicSourceDto>)>(RPC_NAMESPACES.sources.CREATE),
  deleteSource: invoke<((workspaceId: string, sourceSlug: string) => Promise<void>)>(RPC_NAMESPACES.sources.DELETE),
  startSourceOAuth: invoke<((workspaceId: string, sourceSlug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.sources.START_OAUTH),
  saveSourceCredentials: invoke<((workspaceId: string, sourceSlug: string, credential: string) => Promise<void>)>(RPC_NAMESPACES.sources.SAVE_CREDENTIALS),
  getSourcePermissionsConfig: invoke<((workspaceId: string, sourceSlug: string) => Promise<PermissionsConfigFile | null>)>(RPC_NAMESPACES.sources.GET_PERMISSIONS),
  getWorkspacePermissionsConfig: invoke<((workspaceId: string) => Promise<PermissionsConfigFile | null>)>(RPC_NAMESPACES.workspace.GET_PERMISSIONS),
  getDefaultPermissionsConfig: invoke<(() => Promise<{ config: PermissionsConfigFile | null; path: string }>)>(RPC_NAMESPACES.permissions.GET_DEFAULTS),
  getMcpTools: invoke<((workspaceId: string, sourceSlug: string) => Promise<McpToolsResult>)>(RPC_NAMESPACES.sources.GET_MCP_TOOLS),
  getComposioCatalogCapability: invoke<(() => Promise<{ available: boolean }>)>(RPC_NAMESPACES.sources.CATALOG_CAPABILITY),
  discoverComposioCatalog: invoke<((workspaceId: string, query: string) => Promise<ComposioCatalogItem[]>)>(RPC_NAMESPACES.sources.DISCOVER_CATALOG),
  materializeComposioCatalogSource: invoke<((workspaceId: string, item: ComposioCatalogItem) => Promise<PublicSourceDto>)>(RPC_NAMESPACES.sources.MATERIALIZE_CATALOG),
  performOAuth: local<((args: { sourceSlug: string; sessionId?: string; authRequestId?: string }) => Promise<{ success: boolean; error?: string; email?: string }>)>(),
  oauthRevoke: invoke<((sourceSlug: string) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.oauth.REVOKE),
  searchSessionContent: invoke<((workspaceId: string, query: string, searchId?: string) => Promise<SessionSearchResult[]>)>(RPC_NAMESPACES.sessions.SEARCH_CONTENT),
  onSourcesChanged: event<((callback: (workspaceId: string, sources: PublicSourceDto[]) => void) => () => void)>(RPC_NAMESPACES.sources.CHANGED),
  onDefaultPermissionsChanged: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.permissions.DEFAULTS_CHANGED),
  getSkills: invoke<((workspaceId: string, workingDirectory?: string) => Promise<LoadedSkill[]>)>(RPC_NAMESPACES.skills.GET),
  getSkillFiles: invoke<((workspaceId: string, skillSlug: string) => Promise<SkillFile[]>)>(RPC_NAMESPACES.skills.GET_FILES),
  deleteSkill: invoke<((workspaceId: string, skillSlug: string) => Promise<void>)>(RPC_NAMESPACES.skills.DELETE),
  openSkillInEditor: invoke<((workspaceId: string, skillSlug: string) => Promise<void>)>(RPC_NAMESPACES.skills.OPEN_EDITOR),
  openSkillInFinder: invoke<((workspaceId: string, skillSlug: string) => Promise<void>)>(RPC_NAMESPACES.skills.OPEN_FINDER),
  onSkillsChanged: event<((callback: (workspaceId: string, skills: LoadedSkill[]) => void) => () => void)>(RPC_NAMESPACES.skills.CHANGED),
  listStatuses: invoke<((workspaceId: string) => Promise<StatusConfig[]>)>(RPC_NAMESPACES.statuses.LIST),
  reorderStatuses: invoke<((workspaceId: string, orderedIds: string[]) => Promise<void>)>(RPC_NAMESPACES.statuses.REORDER),
  onStatusesChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.statuses.CHANGED),
  listLabels: invoke<((workspaceId: string) => Promise<LabelConfig[]>)>(RPC_NAMESPACES.labels.LIST),
  createLabel: invoke<((workspaceId: string, input: CreateLabelInput) => Promise<LabelConfig>)>(RPC_NAMESPACES.labels.CREATE),
  deleteLabel: invoke<((workspaceId: string, labelId: string) => Promise<{ stripped: number }>)>(RPC_NAMESPACES.labels.DELETE),
  onLabelsChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.labels.CHANGED),
  listChannels: invoke<((workspaceId: string) => Promise<WarRoomChannel[]>)>(RPC_NAMESPACES.channels.LIST),
  createChannel: invoke<((workspaceId: string, input: CreateWarRoomChannelInput) => Promise<WarRoomChannel>)>(RPC_NAMESPACES.channels.CREATE),
  updateChannel: invoke<((workspaceId: string, channelId: string, updates: UpdateWarRoomChannelInput) => Promise<WarRoomChannel>)>(RPC_NAMESPACES.channels.UPDATE),
  deleteChannel: invoke<((workspaceId: string, channelId: string, options?: DeleteChannelOptions) => Promise<DeleteChannelResult>)>(RPC_NAMESPACES.channels.DELETE),
  listChannelMessages: invoke<((workspaceId: string, channelId: string) => Promise<ChannelMessage[]>)>(RPC_NAMESPACES.channels.LIST_MESSAGES),
  listChannelDispatches: invoke<((workspaceId: string, channelId: string) => Promise<WarRoomDispatch[]>)>(RPC_NAMESPACES.channels.LIST_DISPATCHES),
  sendChannelMessage: invoke<((workspaceId: string, input: {
    channelId: string
    text: string
    authorId?: string
    mentionedParticipantIds?: string[]
  }) => Promise<{
    message: ChannelMessage
    targetedParticipantIds: string[]
    unknownMentions: string[]
    failures: Array<{ participantId: string; message: string }>
    dispatches: WarRoomDispatch[]
  }>)>(RPC_NAMESPACES.channels.SEND_MESSAGE),
  onChannelsChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.channels.CHANGED),
  onChannelMessagesChanged: event<((callback: (workspaceId: string, channelId: string) => void) => () => void)>(RPC_NAMESPACES.channels.MESSAGES_CHANGED),
  onLlmConnectionsChanged: event<((callback: () => void) => () => void)>(RPC_NAMESPACES.llmConnections.CHANGED),
  listViews: invoke<((workspaceId: string) => Promise<ViewConfig[]>)>(RPC_NAMESPACES.views.LIST),
  saveViews: invoke<((workspaceId: string, views: ViewConfig[]) => Promise<void>)>(RPC_NAMESPACES.views.SAVE),
  readWorkspaceImage: invoke<((workspaceId: string, relativePath: string) => Promise<string>)>(RPC_NAMESPACES.workspace.READ_IMAGE),
  writeWorkspaceImage: invoke<((workspaceId: string, relativePath: string, base64: string, mimeType: string) => Promise<void>)>(RPC_NAMESPACES.workspace.WRITE_IMAGE),
  getToolIconMappings: invoke<(() => Promise<ToolIconMapping[]>)>(RPC_NAMESPACES.toolIcons.GET_MAPPINGS),
  getAppTheme: invoke<(() => Promise<ThemeOverrides | null>)>(RPC_NAMESPACES.theme.GET_APP),
  setAppTheme: invoke<((theme: ThemeOverrides | null) => Promise<void>)>(RPC_NAMESPACES.theme.SET_APP),
  loadPresetThemes: invoke<(() => Promise<PresetTheme[]>)>(RPC_NAMESPACES.theme.GET_PRESETS),
  loadPresetTheme: invoke<((themeId: string) => Promise<PresetTheme | null>)>(RPC_NAMESPACES.theme.LOAD_PRESET),
  getColorTheme: invoke<(() => Promise<string>)>(RPC_NAMESPACES.theme.GET_COLOR_THEME),
  setColorTheme: invoke<((themeId: string) => Promise<void>)>(RPC_NAMESPACES.theme.SET_COLOR_THEME),
  getWorkspaceColorTheme: invoke<((workspaceId: string) => Promise<string | null>)>(RPC_NAMESPACES.theme.GET_WORKSPACE_COLOR_THEME),
  setWorkspaceColorTheme: invoke<((workspaceId: string, themeId: string | null) => Promise<void>)>(RPC_NAMESPACES.theme.SET_WORKSPACE_COLOR_THEME),
  getAllWorkspaceThemes: invoke<(() => Promise<Record<string, string | undefined>>)>(RPC_NAMESPACES.theme.GET_ALL_WORKSPACE_THEMES),
  onAppThemeChange: event<((callback: (theme: ThemeOverrides | null) => void) => () => void)>(RPC_NAMESPACES.theme.APP_CHANGED),
  getLogoUrl: invoke<((serviceUrl: string, provider?: string) => Promise<string | null>)>(RPC_NAMESPACES.logo.GET_URL),
  showNotification: invoke<((title: string, body: string, workspaceId: string, sessionId: string) => Promise<void>)>(RPC_NAMESPACES.notification.SHOW),
  getNotificationsEnabled: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.notification.GET_ENABLED),
  setNotificationsEnabled: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.notification.SET_ENABLED),
  getAutoCapitalisation: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.input.GET_AUTO_CAPITALISATION),
  setAutoCapitalisation: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.input.SET_AUTO_CAPITALISATION),
  getSendMessageKey: invoke<(() => Promise<'enter' | 'cmd-enter'>)>(RPC_NAMESPACES.input.GET_SEND_MESSAGE_KEY),
  setSendMessageKey: invoke<((key: 'enter' | 'cmd-enter') => Promise<void>)>(RPC_NAMESPACES.input.SET_SEND_MESSAGE_KEY),
  getSpellCheck: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.input.GET_SPELL_CHECK),
  setSpellCheck: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.input.SET_SPELL_CHECK),
  getKeepAwakeWhileRunning: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.power.GET_KEEP_AWAKE),
  setKeepAwakeWhileRunning: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.power.SET_KEEP_AWAKE),
  getBrowserToolEnabled: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.tools.GET_BROWSER_TOOL_ENABLED),
  setBrowserToolEnabled: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.tools.SET_BROWSER_TOOL_ENABLED),
  getRichToolDescriptions: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.appearance.GET_RICH_TOOL_DESCRIPTIONS),
  setRichToolDescriptions: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.appearance.SET_RICH_TOOL_DESCRIPTIONS),
  getAutoExpandActivities: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.appearance.GET_AUTO_EXPAND_ACTIVITIES),
  setAutoExpandActivities: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.appearance.SET_AUTO_EXPAND_ACTIVITIES),
  getExtendedPromptCache: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.caching.GET_EXTENDED_PROMPT_CACHE),
  setExtendedPromptCache: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.caching.SET_EXTENDED_PROMPT_CACHE),
  getEnable1MContext: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.caching.GET_ENABLE_1M_CONTEXT),
  setEnable1MContext: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.caching.SET_ENABLE_1M_CONTEXT),
  getRtkEnabled: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.rtk.GET_ENABLED),
  setRtkEnabled: invoke<((enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.rtk.SET_ENABLED),
  getRtkStatus: invoke<((opts?: { forceRecheck?: boolean }) => Promise<{ installed: boolean; path: string | null; version: string | null }>)>(RPC_NAMESPACES.rtk.GET_STATUS),
  getRtkGain: invoke<(() => Promise<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>)>(RPC_NAMESPACES.rtk.GET_GAIN),
  getNetworkProxySettings: invoke<(() => Promise<NetworkProxySettings | undefined>)>(RPC_NAMESPACES.settings.GET_NETWORK_PROXY),
  setNetworkProxySettings: invoke<((settings: NetworkProxySettings) => Promise<void>)>(RPC_NAMESPACES.settings.SET_NETWORK_PROXY),
  refreshBadge: invoke<(() => Promise<void>)>(RPC_NAMESPACES.badge.REFRESH),
  setDockIconWithBadge: invoke<((dataUrl: string) => Promise<void>)>(RPC_NAMESPACES.badge.SET_ICON),
  onBadgeDraw: event<((callback: (data: { count: number; iconDataUrl: string }) => void) => () => void)>(RPC_NAMESPACES.badge.DRAW),
  onBadgeDrawWindows: event<((callback: (data: { count: number }) => void) => () => void)>(RPC_NAMESPACES.badge.DRAW_WINDOWS),
  getWindowFocusState: invoke<(() => Promise<boolean>)>(RPC_NAMESPACES.window.GET_FOCUS_STATE),
  onWindowFocusChange: event<((callback: (isFocused: boolean) => void) => () => void)>(RPC_NAMESPACES.window.FOCUS_STATE),
  onNotificationNavigate: event<((callback: (data: { workspaceId: string; sessionId: string }) => void) => () => void)>(RPC_NAMESPACES.notification.NAVIGATE),
  broadcastThemePreferences: invoke<((preferences: { mode: string; colorTheme: string; font: string }) => Promise<void>)>(RPC_NAMESPACES.theme.BROADCAST_PREFERENCES),
  onThemePreferencesChange: event<((callback: (preferences: { mode: string; colorTheme: string; font: string }) => void) => () => void)>(RPC_NAMESPACES.theme.PREFERENCES_CHANGED),
  broadcastWorkspaceThemeChange: invoke<((workspaceId: string, themeId: string | null) => Promise<void>)>(RPC_NAMESPACES.theme.BROADCAST_WORKSPACE_THEME),
  onWorkspaceThemeChange: event<((callback: (data: { workspaceId: string; themeId: string | null }) => void) => () => void)>(RPC_NAMESPACES.theme.WORKSPACE_THEME_CHANGED),
  getGitBranch: invoke<((dirPath: string) => Promise<string | null>)>(RPC_NAMESPACES.git.GET_BRANCH),
  checkGitBash: invoke<(() => Promise<GitBashStatus>)>(RPC_NAMESPACES.gitbash.CHECK),
  browseForGitBash: invoke<(() => Promise<string | null>)>(RPC_NAMESPACES.gitbash.BROWSE),
  setGitBashPath: invoke<((path: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.gitbash.SET_PATH),
  menuQuit: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.QUIT),
  menuNewWindow: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.NEW_WINDOW),
  menuMinimize: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.MINIMIZE),
  menuMaximize: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.MAXIMIZE),
  menuZoomIn: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.ZOOM_IN),
  menuZoomOut: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.ZOOM_OUT),
  menuZoomReset: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.ZOOM_RESET),
  menuToggleDevTools: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.TOGGLE_DEV_TOOLS),
  menuUndo: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.UNDO),
  menuRedo: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.REDO),
  menuCut: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.CUT),
  menuCopy: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.COPY),
  menuPaste: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.PASTE),
  menuSelectAll: invoke<(() => Promise<void>)>(RPC_NAMESPACES.menu.SELECT_ALL),
  listLlmConnections: invoke<(() => Promise<LlmConnection[]>)>(RPC_NAMESPACES.llmConnections.LIST),
  listLlmConnectionsWithStatus: invoke<(() => Promise<LlmConnectionWithStatus[]>)>(RPC_NAMESPACES.llmConnections.LIST_WITH_STATUS),
  getLlmConnection: invoke<((slug: string) => Promise<LlmConnection | null>)>(RPC_NAMESPACES.llmConnections.GET),
  getLlmConnectionApiKey: invoke<((slug: string) => Promise<string | null>)>(RPC_NAMESPACES.llmConnections.GET_API_KEY),
  saveLlmConnection: invoke<((connection: LlmConnection) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.llmConnections.SAVE),
  deleteLlmConnection: invoke<((slug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.llmConnections.DELETE),
  testLlmConnection: invoke<((slug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.llmConnections.TEST),
  setDefaultLlmConnection: invoke<((slug: string) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.llmConnections.SET_DEFAULT),
  getDefaultThinkingLevel: invoke<(() => Promise<ThinkingLevel>)>(RPC_NAMESPACES.settings.GET_DEFAULT_THINKING_LEVEL),
  setDefaultThinkingLevel: invoke<((level: ThinkingLevel) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.settings.SET_DEFAULT_THINKING_LEVEL),
  setWorkspaceDefaultLlmConnection: invoke<((workspaceId: string, slug: string | null) => Promise<{ success: boolean; error?: string }>)>(RPC_NAMESPACES.llmConnections.SET_WORKSPACE_DEFAULT),
  getProjects: invoke<((workspaceId: string) => Promise<unknown>)>(RPC_NAMESPACES.projects.GET),
  getProject: invoke<((workspaceId: string, projectIdOrSlug: string) => Promise<unknown | null>)>(RPC_NAMESPACES.projects.GET_ONE),
  createProject: invoke<((workspaceId: string, input: CreateProjectInput) => Promise<ProjectConfig>)>(RPC_NAMESPACES.projects.CREATE),
  updateProject: invoke<((workspaceId: string, projectSlug: string, patch: Partial<Omit<ProjectConfig, 'id' | 'slug' | 'createdAt'>>) => Promise<ProjectConfig>)>(RPC_NAMESPACES.projects.UPDATE),
  deleteProject: invoke<((workspaceId: string, projectSlug: string) => Promise<void>)>(RPC_NAMESPACES.projects.DELETE),
  listProjectAssets: invoke<((workspaceId: string, projectSlug: string) => Promise<unknown>)>(RPC_NAMESPACES.projects.LIST_ASSETS),
  uploadProjectAsset: invoke<((workspaceId: string, projectSlug: string, input: { filename: string; base64?: string; text?: string; sourcePath?: string }) => Promise<ProjectAsset>)>(RPC_NAMESPACES.projects.UPLOAD_ASSET),
  deleteProjectAsset: invoke<((workspaceId: string, projectSlug: string, filename: string) => Promise<void>)>(RPC_NAMESPACES.projects.DELETE_ASSET),
  onProjectsChanged: event<((callback: (workspaceId: string, projects: unknown) => void) => () => void)>(RPC_NAMESPACES.projects.CHANGED),
  getAutomations: invoke<((workspaceId: string) => Promise<unknown>)>(RPC_NAMESPACES.automations.GET),
  testAutomation: invoke<((payload: TestAutomationPayload) => Promise<TestAutomationResult>)>(RPC_NAMESPACES.automations.TEST),
  setAutomationEnabled: invoke<((workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean) => Promise<void>)>(RPC_NAMESPACES.automations.SET_ENABLED),
  duplicateAutomation: invoke<((workspaceId: string, eventName: string, matcherIndex: number) => Promise<void>)>(RPC_NAMESPACES.automations.DUPLICATE),
  deleteAutomation: invoke<((workspaceId: string, eventName: string, matcherIndex: number) => Promise<void>)>(RPC_NAMESPACES.automations.DELETE),
  getAutomationHistory: invoke<((workspaceId: string, automationId: string, limit?: number) => Promise<Array<{ id: string; ts: number; ok: boolean; sessionId?: string; prompt?: string; error?: string; webhook?: { method: string; url: string; statusCode: number; durationMs: number; attempts?: number; error?: string; responseBody?: string } }>>)>(RPC_NAMESPACES.automations.GET_HISTORY),
  getAutomationLastExecuted: invoke<((workspaceId: string) => Promise<Record<string, number>>)>(RPC_NAMESPACES.automations.GET_LAST_EXECUTED),
  replayAutomation: invoke<((workspaceId: string, automationId: string, eventName: string) => Promise<{ results: Array<{ type: string; url: string; statusCode: number; success: boolean; error?: string; duration: number }> }>)>(RPC_NAMESPACES.automations.REPLAY),
  onAutomationsChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.automations.CHANGED),
  changeLanguage: local<((lang: string) => Promise<void>)>(),
  exportResources: invoke<((workspaceId: string, options: ExportResourcesOptions) => Promise<ExportResult>)>(RPC_NAMESPACES.resources.EXPORT),
  importResources: invoke<((workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode) => Promise<ResourceImportResult>)>(RPC_NAMESPACES.resources.IMPORT),
  getMessagingConfig: invoke<(() => Promise<{
    enabled: boolean
    platforms: Record<string, { enabled: boolean; accessMode?: MessagingPlatformAccessMode; owners?: MessagingPlatformOwnerInfo[] } | undefined>
    runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
  } | null>)>(RPC_NAMESPACES.messaging.GET_CONFIG),
  updateMessagingConfig: invoke<((config: Record<string, unknown>) => Promise<void>)>(RPC_NAMESPACES.messaging.UPDATE_CONFIG),
  testTelegramToken: invoke<((token: string) => Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>)>(RPC_NAMESPACES.messaging.TEST_TELEGRAM),
  saveTelegramToken: invoke<((token: string) => Promise<void>)>(RPC_NAMESPACES.messaging.SAVE_TELEGRAM),
  saveLarkCredentials: invoke<((credentialsJson: string) => Promise<void>)>(RPC_NAMESPACES.messaging.SAVE_LARK),
  disconnectMessagingPlatform: invoke<((platform: string) => Promise<void>)>(RPC_NAMESPACES.messaging.DISCONNECT),
  forgetMessagingPlatform: invoke<((platform: string) => Promise<void>)>(RPC_NAMESPACES.messaging.FORGET),
  getMessagingBindings: invoke<(() => Promise<Array<{ id: string; workspaceId: string; sessionId: string; platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean; createdAt: number; accessMode?: MessagingBindingAccessMode; allowedSenderIds?: string[] }>>)>(RPC_NAMESPACES.messaging.GET_BINDINGS),
  generateMessagingPairingCode: invoke<((sessionId: string, platform: string) => Promise<{ code: string; expiresAt: number; botUsername?: string }>)>(RPC_NAMESPACES.messaging.GENERATE_CODE),
  /** Telegram supergroup pairing — returns a code typed in the supergroup to capture its chatId. */
  generateMessagingSupergroupCode: invoke<((platform: string) => Promise<{ code: string; expiresAt: number; botUsername?: string }>)>(RPC_NAMESPACES.messaging.GENERATE_SUPERGROUP_CODE),
  /** Read the workspace's currently paired Telegram supergroup, if any. */
  getMessagingSupergroup: invoke<(() => Promise<{ chatId: string; title: string; capturedAt: number } | null>)>(RPC_NAMESPACES.messaging.GET_SUPERGROUP),
  /** Forget the paired Telegram supergroup (existing topic bindings stay on disk but stop matching). */
  unbindMessagingSupergroup: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.UNBIND_SUPERGROUP),
  unbindMessagingSession: invoke<((sessionId: string, platform?: string) => Promise<void>)>(RPC_NAMESPACES.messaging.UNBIND),
  unbindMessagingBinding: invoke<((bindingId: string) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.UNBIND_BINDING),
  onMessagingBindingChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.messaging.BINDING_CHANGED),
  onMessagingPlatformStatus: event<((callback: (workspaceId: string, platform: string, status: MessagingPlatformRuntimeInfo) => void) => () => void)>(RPC_NAMESPACES.messaging.PLATFORM_STATUS),
  startWhatsAppConnect: invoke<(() => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.WA_START_CONNECT),
  submitWhatsAppPhone: invoke<((phoneNumber: string) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.WA_SUBMIT_PHONE),
  onWhatsAppEvent: event<((callback: (payload: { workspaceId: string; event: WhatsAppUiEvent }) => void) => () => void)>(RPC_NAMESPACES.messaging.WA_UI_EVENT),
  getMessagingPlatformOwners: invoke<((platform: string) => Promise<MessagingPlatformOwnerInfo[]>)>(RPC_NAMESPACES.messaging.GET_PLATFORM_OWNERS),
  setMessagingPlatformOwners: invoke<((platform: string, owners: MessagingPlatformOwnerInfo[]) => Promise<MessagingPlatformOwnerInfo[]>)>(RPC_NAMESPACES.messaging.SET_PLATFORM_OWNERS),
  getMessagingPlatformAccessMode: invoke<((platform: string) => Promise<MessagingPlatformAccessMode>)>(RPC_NAMESPACES.messaging.GET_PLATFORM_ACCESS_MODE),
  setMessagingPlatformAccessMode: invoke<((platform: string, mode: MessagingPlatformAccessMode) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.SET_PLATFORM_ACCESS_MODE),
  getMessagingPendingSenders: invoke<((platform?: string) => Promise<MessagingPendingSenderInfo[]>)>(RPC_NAMESPACES.messaging.GET_PENDING_SENDERS),
  dismissMessagingPendingSender: invoke<((platform: string, userId: string, opts?: { reason?: MessagingPendingRejectReason; bindingId?: string }) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.DISMISS_PENDING_SENDER),
  allowMessagingPendingSender: invoke<((platform: string, userId: string, entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string }) => Promise<{ owners: MessagingPlatformOwnerInfo[]; bindingId?: string }>)>(RPC_NAMESPACES.messaging.ALLOW_PENDING_SENDER),
  setMessagingBindingAccess: invoke<((bindingId: string, access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] }) => Promise<{ success: boolean }>)>(RPC_NAMESPACES.messaging.SET_BINDING_ACCESS),
  onMessagingPendingChanged: event<((callback: (workspaceId: string) => void) => () => void)>(RPC_NAMESPACES.messaging.PENDING_CHANGED),
  'meetings.start': invoke<((workspaceId: string, input: string | MeetingStartInput) => Promise<MeetingRecord>)>(RPC_NAMESPACES.meetings.START),
  'meetings.list': invoke<((workspaceId: string) => Promise<MeetingRecord[]>)>(RPC_NAMESPACES.meetings.LIST),
  'meetings.status': invoke<((workspaceId: string, id: string) => Promise<MeetingRecord | null>)>(RPC_NAMESPACES.meetings.STATUS),
  'meetings.stop': invoke<((workspaceId: string, id: string) => Promise<MeetingRecord>)>(RPC_NAMESPACES.meetings.STOP),
  'meetings.transcript': invoke<((workspaceId: string, id: string) => Promise<MeetingTranscriptResult>)>(RPC_NAMESPACES.meetings.TRANSCRIPT),
  'meetings.getTranscriptionConfig': invoke<((workspaceId: string) => Promise<MeetingTranscriptionConfig>)>(RPC_NAMESPACES.meetings.GET_TRANSCRIPTION_CONFIG),
  'meetings.saveTranscriptionConfig': invoke<((workspaceId: string, input: SaveMeetingTranscriptionConfigInput) => Promise<MeetingTranscriptionConfig>)>(RPC_NAMESPACES.meetings.SAVE_TRANSCRIPTION_CONFIG),
  'meetings.archive': invoke<((workspaceId: string, id: string) => Promise<MeetingRecord>)>(RPC_NAMESPACES.meetings.ARCHIVE),
  'meetings.unarchive': invoke<((workspaceId: string, id: string) => Promise<MeetingRecord>)>(RPC_NAMESPACES.meetings.UNARCHIVE),
  'meetings.deleteMeeting': invoke<((workspaceId: string, id: string) => Promise<void>)>(RPC_NAMESPACES.meetings.DELETE),
  'browserPane.create': invoke<((input?: string | BrowserPaneCreateOptions) => Promise<string>)>(RPC_NAMESPACES.browserPane.CREATE),
  'browserPane.destroy': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.DESTROY),
  'browserPane.list': invoke<(() => Promise<BrowserInstanceInfo[]>)>(RPC_NAMESPACES.browserPane.LIST),
  'browserPane.navigate': invoke<((id: string, url: string) => Promise<{ url: string; title: string }>)>(RPC_NAMESPACES.browserPane.NAVIGATE),
  'browserPane.goBack': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.GO_BACK),
  'browserPane.goForward': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.GO_FORWARD),
  'browserPane.reload': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.RELOAD),
  'browserPane.stop': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.STOP),
  'browserPane.focus': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.FOCUS),
  'browserPane.emptyStateLaunch': invoke<((payload: BrowserEmptyStateLaunchPayload) => Promise<BrowserEmptyStateLaunchResult>)>(RPC_NAMESPACES.browserPane.LAUNCH),
  'browserPane.onStateChanged': event<((callback: (info: BrowserInstanceInfo) => void) => () => void)>(RPC_NAMESPACES.browserPane.STATE_CHANGED),
  'browserPane.onRemoved': event<((callback: (id: string) => void) => () => void)>(RPC_NAMESPACES.browserPane.REMOVED),
  'browserPane.onInteracted': event<((callback: (id: string) => void) => () => void)>(RPC_NAMESPACES.browserPane.INTERACTED),
  'browserPane.listProfiles': invoke<(() => Promise<BrowserProfile[]>)>(RPC_NAMESPACES.browserPane.LIST_PROFILES),
  'browserPane.getProfileSettings': invoke<(() => Promise<BrowserProfileSettings>)>(RPC_NAMESPACES.browserPane.GET_PROFILE_SETTINGS),
  'browserPane.setProfileSettings': invoke<((partial: { alwaysAsk?: boolean; lastUsedProfileId?: string }) => Promise<BrowserProfileSettings>)>(RPC_NAMESPACES.browserPane.SET_PROFILE_SETTINGS),
  'browserPane.createProfile': invoke<((input: BrowserProfileInput) => Promise<BrowserProfile>)>(RPC_NAMESPACES.browserPane.CREATE_PROFILE),
  'browserPane.renameProfile': invoke<((payload: { id: string; name: string }) => Promise<BrowserProfile>)>(RPC_NAMESPACES.browserPane.RENAME_PROFILE),
  'browserPane.switchProfile': invoke<((payload: { instanceId: string; profileId: string }) => Promise<string | null>)>(RPC_NAMESPACES.browserPane.SWITCH_PROFILE),
  'browserPane.deleteProfile': invoke<((id: string) => Promise<void>)>(RPC_NAMESPACES.browserPane.DELETE_PROFILE),
  /** Desktop only: move the native views between the instance window and a card inside the app. */
  'browserPane.setDisplayMode': invoke<((id: string, mode: 'floating' | 'integrated') => Promise<boolean>)>(RPC_NAMESPACES.browserPane.SET_DISPLAY_MODE),
  /** Card geometry in host CSS px; the main process resolves the zoom factor and converts to DIPs. */
  'browserPane.setEmbeddedBounds': invoke<((id: string, rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>)>(RPC_NAMESPACES.browserPane.SET_EMBEDDED_BOUNDS),
  /** Desktop only: take the native views off screen while an app overlay reaches over them. */
  'browserPane.setViewsVisible': invoke<((id: string, visible: boolean) => Promise<boolean>)>(RPC_NAMESPACES.browserPane.SET_VIEWS_VISIBLE),
  'browserPane.onProfilesChanged': event<((callback: (settings: BrowserProfileSettings) => void) => () => void)>(RPC_NAMESPACES.browserPane.PROFILES_CHANGED),
  'browserPane.onPickerRequested': event<((callback: (data: { instanceId: string }) => void) => () => void)>(RPC_NAMESPACES.browserPane.PICKER_REQUESTED),
  'browserPane.onDisplayModeRequested': event<((callback: (data: { instanceId: string; mode: 'floating' | 'integrated' }) => void) => () => void)>(RPC_NAMESPACES.browserPane.DISPLAY_MODE_REQUESTED),
} satisfies Record<string, RpcLeaf<RpcLeafKind, unknown>>

// ── ElectronAPI — derived from RPC_CONTRACT ─────────────────────────────────
type SigOf<L> = L extends RpcLeaf<RpcLeafKind, infer S> ? S : never
type RpcContract = typeof RPC_CONTRACT
type RpcContractKey = keyof RpcContract & string

type FlatApi = {
  [K in RpcContractKey as K extends `${string}.${string}` ? never : K]: SigOf<RpcContract[K]>
}
type NsPrefix = { [K in RpcContractKey]: K extends `${infer P}.${string}` ? P : never }[RpcContractKey]
type NestedApi = {
  [P in NsPrefix]: {
    [K in RpcContractKey as K extends `${P}.${infer M}` ? M : never]: SigOf<RpcContract[K]>
  }
}

/**
 * Type-safe IPC API exposed to the renderer. Derived from {@link RPC_CONTRACT};
 * do not hand-edit method signatures here — edit the contract entry instead.
 * `getSkillFiles` stays optional because the web adapter may omit it.
 */
export type ElectronAPI =
  Omit<FlatApi & NestedApi, 'getSkillFiles'> & {
    getSkillFiles?: SigOf<RpcContract['getSkillFiles']>
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
 * Workspace-level access policy for a messaging platform.
 * Mirrors the canonical type in `@craft-agent/messaging-gateway`.
 */
export type MessagingPlatformAccessMode = 'open' | 'owner-only'

/** Per-binding access policy. */
export type MessagingBindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface MessagingPlatformOwnerInfo {
  userId: string
  displayName?: string
  username?: string
  addedAt: number
}

export type MessagingPendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

export interface MessagingPendingSenderInfo {
  platform: string
  userId: string
  displayName?: string
  username?: string
  lastAttemptAt: number
  attemptCount: number
  reason?: MessagingPendingRejectReason
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

/** Event payloads broadcast from the WhatsApp subprocess to the UI. */
export type WhatsAppUiEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

// =============================================================================
// Navigation types (renderer-only)
// =============================================================================

/**
 * Right sidebar panel types
 */
export type RightSidebarPanel =
  | { type: 'files'; path?: string }
  | { type: 'history' }
  | { type: 'session-info' }
  | { type: 'none' }

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'flagged' }
  | { kind: 'state'; stateId: string }
  | { kind: 'label'; labelId: string }
  | { kind: 'view'; viewId: string }
  | { kind: 'archived' }

/**
 * Settings subpage options - re-exported from settings-registry (single source of truth)
 */
export type { SettingsSubpage } from './settings-registry'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions'
  filter: SessionFilter
  details: { type: 'session'; sessionId: string } | null
  rightSidebar?: RightSidebarPanel
  /**
   * Presentation mode for the sessions navigator. `'board'` renders the Kanban
   * board (all sessions, grouped into To Do / In Progress / Done columns) in the
   * content area instead of the list + chat. Absent/`'list'` is the default.
   */
  viewMode?: 'list' | 'board'
}

/**
 * Source type filter for sources navigation
 */
export interface SourceFilter {
  kind: 'type'
  sourceType: 'api' | 'mcp' | 'local'
}

/**
 * Automation type filter for automations navigation
 */
export interface AutomationFilter {
  kind: 'type'
  automationType: 'scheduled' | 'event' | 'agentic'
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources'
  filter?: SourceFilter
  details: { type: 'source'; sourceSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Settings navigation state
 *
 * `subpage: null` means the bare `settings` route — navigator-only view in compact
 * mode. On desktop, the content panel falls back to the App page so it isn't empty.
 * Sources/Skills/Automations use `details: null` for the same purpose.
 */
export interface SettingsNavigationState {
  navigator: 'settings'
  subpage: SettingsSubpage | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills'
  details: { type: 'skill'; skillSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Automations navigation state
 */
export interface AutomationsNavigationState {
  navigator: 'automations'
  filter?: AutomationFilter
  details: { type: 'automation'; automationId: string } | null
  rightSidebar?: RightSidebarPanel
}

export interface MeetingsNavigationState {
  navigator: 'meetings'
  details: { type: 'meeting'; meetingId: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Projects navigation state
 */
export interface ProjectsNavigationState {
  navigator: 'projects'
  details: { type: 'project'; projectSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | AutomationsNavigationState
  | MeetingsNavigationState
  | ProjectsNavigationState

export const isSessionsNavigation = (
  state: NavigationState
): state is SessionsNavigationState => state.navigator === 'sessions'

export const isSourcesNavigation = (
  state: NavigationState
): state is SourcesNavigationState => state.navigator === 'sources'

export const isSettingsNavigation = (
  state: NavigationState
): state is SettingsNavigationState => state.navigator === 'settings'

export const isSkillsNavigation = (
  state: NavigationState
): state is SkillsNavigationState => state.navigator === 'skills'

export const isAutomationsNavigation = (
  state: NavigationState
): state is AutomationsNavigationState => state.navigator === 'automations'

export const isMeetingsNavigation = (
  state: NavigationState
): state is MeetingsNavigationState => state.navigator === 'meetings'

export const isProjectsNavigation = (
  state: NavigationState
): state is ProjectsNavigationState => state.navigator === 'projects'

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
