/**
 * Channel map — maps ElectronAPI method names to IPC channels.
 *
 * Derived from preload/index.ts. This is the single source of truth for
 * the method→channel mapping used by buildClientApi().
 */

import { RPC_NAMESPACES } from '../shared/types'
import type { ChannelMap } from './build-api'

function invoke(channel: string, transform?: (result: any) => any) {
  return { type: 'invoke' as const, channel, ...(transform && { transform }) }
}

function listener(channel: string) {
  return { type: 'listener' as const, channel }
}

export const CHANNEL_MAP = {
  // Session management
  getSessions: invoke(RPC_NAMESPACES.sessions.GET),
  getUnreadSummary: invoke(RPC_NAMESPACES.sessions.GET_UNREAD_SUMMARY),
  markAllSessionsRead: invoke(RPC_NAMESPACES.sessions.MARK_ALL_READ),
  getSessionMessages: invoke(RPC_NAMESPACES.sessions.GET_MESSAGES),
  createSession: invoke(RPC_NAMESPACES.sessions.CREATE),
  deleteSession: invoke(RPC_NAMESPACES.sessions.DELETE),
  sendMessage: invoke(RPC_NAMESPACES.sessions.SEND_MESSAGE),
  cancelProcessing: invoke(RPC_NAMESPACES.sessions.CANCEL),
  killShell: invoke(RPC_NAMESPACES.sessions.KILL_SHELL),
  getTaskOutput: invoke(RPC_NAMESPACES.tasks.GET_OUTPUT),

  // Tasks (Conductor)
  validateTask: invoke(RPC_NAMESPACES.tasks.VALIDATE),
  createTask: invoke(RPC_NAMESPACES.tasks.CREATE),
  generateTask: invoke(RPC_NAMESPACES.tasks.GENERATE),
  runTask: invoke(RPC_NAMESPACES.tasks.RUN),
  pauseTask: invoke(RPC_NAMESPACES.tasks.PAUSE),
  resumeTask: invoke(RPC_NAMESPACES.tasks.RESUME),
  stopTask: invoke(RPC_NAMESPACES.tasks.STOP),
  getTask: invoke(RPC_NAMESPACES.tasks.GET),
  listTasks: invoke(RPC_NAMESPACES.tasks.LIST),
  getTaskResults: invoke(RPC_NAMESPACES.tasks.GET_RESULTS),
  onTaskGenerated: listener(RPC_NAMESPACES.tasks.GENERATED),
  respondToPermission: invoke(RPC_NAMESPACES.sessions.RESPOND_TO_PERMISSION),
  respondToCredential: invoke(RPC_NAMESPACES.sessions.RESPOND_TO_CREDENTIAL),
  respondToUserQuestion: invoke(RPC_NAMESPACES.sessions.RESPOND_TO_USER_QUESTION),
  sessionCommand: invoke(RPC_NAMESPACES.sessions.COMMAND),
  exportSession: invoke(RPC_NAMESPACES.sessions.EXPORT),
  importSession: invoke(RPC_NAMESPACES.sessions.IMPORT),
  exportRemoteSessionTransfer: invoke(RPC_NAMESPACES.sessions.EXPORT_REMOTE_TRANSFER),
  importRemoteSessionTransfer: invoke(RPC_NAMESPACES.sessions.IMPORT_REMOTE_TRANSFER),
  getPendingPlanExecution: invoke(RPC_NAMESPACES.sessions.GET_PENDING_PLAN_EXECUTION),
  getSessionPermissionModeState: invoke(RPC_NAMESPACES.sessions.GET_PERMISSION_MODE_STATE),

  // Event listeners
  onSessionEvent: listener(RPC_NAMESPACES.sessions.EVENT),
  onUnreadSummaryChanged: listener(RPC_NAMESPACES.sessions.UNREAD_SUMMARY_CHANGED),

  // Transport reliability
  onReconnected: listener('__transport:reconnected'),

  // Workspace management
  getWorkspaces: invoke(RPC_NAMESPACES.workspaces.GET),
  createWorkspace: invoke(RPC_NAMESPACES.workspaces.CREATE),
  checkWorkspaceSlug: invoke(RPC_NAMESPACES.workspaces.CHECK_SLUG),
  updateWorkspaceRemoteServer: invoke(RPC_NAMESPACES.workspaces.UPDATE_REMOTE),
  testRemoteConnection: invoke(RPC_NAMESPACES.remote.TEST_CONNECTION),

  // Server-level workspace operations (REMOTE_ELIGIBLE)
  getServerWorkspaces: invoke(RPC_NAMESPACES.server.GET_WORKSPACES),
  createServerWorkspace: invoke(RPC_NAMESPACES.server.CREATE_WORKSPACE),

  // Window management
  getWindowWorkspace: invoke(RPC_NAMESPACES.window.GET_WORKSPACE),
  getWindowMode: invoke(RPC_NAMESPACES.window.GET_MODE),
  openWorkspace: invoke(RPC_NAMESPACES.window.OPEN_WORKSPACE),
  openSessionInNewWindow: invoke(RPC_NAMESPACES.window.OPEN_SESSION_IN_NEW_WINDOW),
  switchWorkspace: invoke(RPC_NAMESPACES.window.SWITCH_WORKSPACE),
  closeWindow: invoke(RPC_NAMESPACES.window.CLOSE),
  confirmCloseWindow: invoke(RPC_NAMESPACES.window.CONFIRM_CLOSE),
  cancelCloseWindow: invoke(RPC_NAMESPACES.window.CANCEL_CLOSE),
  onCloseRequested: listener(RPC_NAMESPACES.window.CLOSE_REQUESTED),
  setTrafficLightsVisible: invoke(RPC_NAMESPACES.window.SET_TRAFFIC_LIGHTS),

  // File operations
  readFile: invoke(RPC_NAMESPACES.file.READ),
  readFileDataUrl: invoke(RPC_NAMESPACES.file.READ_DATA_URL),
  readFilePreviewDataUrl: invoke(RPC_NAMESPACES.file.READ_PREVIEW_DATA_URL),
  readFileBinary: invoke(RPC_NAMESPACES.file.READ_BINARY),
  openFileDialog: invoke(RPC_NAMESPACES.file.OPEN_DIALOG),
  readFileAttachment: invoke(RPC_NAMESPACES.file.READ_ATTACHMENT),
  readUserAttachment: invoke(RPC_NAMESPACES.file.READ_USER_ATTACHMENT),
  storeAttachment: invoke(RPC_NAMESPACES.file.STORE_ATTACHMENT),
  generateThumbnail: invoke(RPC_NAMESPACES.file.GENERATE_THUMBNAIL),

  // Theme
  getSystemTheme: invoke(RPC_NAMESPACES.theme.GET_SYSTEM_PREFERENCE),
  onSystemThemeChange: listener(RPC_NAMESPACES.theme.SYSTEM_CHANGED),

  // System
  getVersions: invoke(RPC_NAMESPACES.system.VERSIONS),
  getHomeDir: invoke(RPC_NAMESPACES.system.HOME_DIR),
  isDebugMode: invoke(RPC_NAMESPACES.system.IS_DEBUG_MODE),

  // Auto-update
  checkForUpdates: invoke(RPC_NAMESPACES.update.CHECK),
  getUpdateInfo: invoke(RPC_NAMESPACES.update.GET_INFO),
  installUpdate: invoke(RPC_NAMESPACES.update.INSTALL),
  dismissUpdate: invoke(RPC_NAMESPACES.update.DISMISS),
  getDismissedUpdateVersion: invoke(RPC_NAMESPACES.update.GET_DISMISSED),
  onUpdateAvailable: listener(RPC_NAMESPACES.update.AVAILABLE),
  onUpdateDownloadProgress: listener(RPC_NAMESPACES.update.DOWNLOAD_PROGRESS),

  // Release notes
  getReleaseNotes: invoke(RPC_NAMESPACES.releaseNotes.GET),
  getLatestReleaseVersion: invoke(RPC_NAMESPACES.releaseNotes.GET_LATEST_VERSION),

  // Shell operations
  openUrl: invoke(RPC_NAMESPACES.shell.OPEN_URL),
  openFile: invoke(RPC_NAMESPACES.shell.OPEN_FILE),
  showInFolder: invoke(RPC_NAMESPACES.shell.SHOW_IN_FOLDER),

  // Menu event listeners
  onMenuNewChat: listener(RPC_NAMESPACES.menu.NEW_CHAT),
  onMenuOpenSettings: listener(RPC_NAMESPACES.menu.OPEN_SETTINGS),
  onMenuKeyboardShortcuts: listener(RPC_NAMESPACES.menu.KEYBOARD_SHORTCUTS),
  onMenuToggleFocusMode: listener(RPC_NAMESPACES.menu.TOGGLE_FOCUS_MODE),
  onMenuToggleSidebar: listener(RPC_NAMESPACES.menu.TOGGLE_SIDEBAR),

  // Deep link
  onDeepLinkNavigate: listener(RPC_NAMESPACES.deeplink.NAVIGATE),

  // Auth
  showLogoutConfirmation: invoke(RPC_NAMESPACES.auth.SHOW_LOGOUT_CONFIRMATION),
  showDeleteSessionConfirmation: invoke(RPC_NAMESPACES.auth.SHOW_DELETE_SESSION_CONFIRMATION),
  logout: invoke(RPC_NAMESPACES.auth.LOGOUT),
  getCredentialHealth: invoke(RPC_NAMESPACES.credentials.HEALTH_CHECK),

  // Onboarding
  getAuthState: invoke(RPC_NAMESPACES.onboarding.GET_AUTH_STATE),
  getSetupNeeds: invoke(RPC_NAMESPACES.onboarding.GET_AUTH_STATE, r => r.setupNeeds),
  startWorkspaceMcpOAuth: invoke(RPC_NAMESPACES.onboarding.START_MCP_OAUTH),
  startClaudeOAuth: invoke(RPC_NAMESPACES.onboarding.START_CLAUDE_OAUTH),
  exchangeClaudeCode: invoke(RPC_NAMESPACES.onboarding.EXCHANGE_CLAUDE_CODE),
  hasClaudeOAuthState: invoke(RPC_NAMESPACES.onboarding.HAS_CLAUDE_OAUTH_STATE),
  clearClaudeOAuthState: invoke(RPC_NAMESPACES.onboarding.CLEAR_CLAUDE_OAUTH_STATE),
  deferSetup: invoke(RPC_NAMESPACES.onboarding.DEFER_SETUP),

  // ChatGPT OAuth
  startChatGptOAuth: invoke(RPC_NAMESPACES.chatgpt.START_OAUTH),
  cancelChatGptOAuth: invoke(RPC_NAMESPACES.chatgpt.CANCEL_OAUTH),
  getChatGptAuthStatus: invoke(RPC_NAMESPACES.chatgpt.GET_AUTH_STATUS),
  chatGptLogout: invoke(RPC_NAMESPACES.chatgpt.LOGOUT),

  // GitHub Copilot OAuth
  startCopilotOAuth: invoke(RPC_NAMESPACES.copilot.START_OAUTH),
  cancelCopilotOAuth: invoke(RPC_NAMESPACES.copilot.CANCEL_OAUTH),
  getCopilotAuthStatus: invoke(RPC_NAMESPACES.copilot.GET_AUTH_STATUS),
  copilotLogout: invoke(RPC_NAMESPACES.copilot.LOGOUT),
  onCopilotDeviceCode: listener(RPC_NAMESPACES.copilot.DEVICE_CODE),

  // Server info (REMOTE_ELIGIBLE)
  getServerHomeDir: invoke(RPC_NAMESPACES.server.HOME_DIR),

  // Server mode configuration
  getServerConfig: invoke(RPC_NAMESPACES.settings.GET_SERVER_CONFIG),
  setServerConfig: invoke(RPC_NAMESPACES.settings.SET_SERVER_CONFIG),
  getServerStatus: invoke(RPC_NAMESPACES.settings.GET_SERVER_STATUS),

  // Settings - API Setup
  setupLlmConnection: invoke(RPC_NAMESPACES.settings.SETUP_LLM_CONNECTION),
  testLlmConnectionSetup: invoke(RPC_NAMESPACES.settings.TEST_LLM_CONNECTION_SETUP),
  getDefaultThinkingLevel: invoke(RPC_NAMESPACES.settings.GET_DEFAULT_THINKING_LEVEL),
  setDefaultThinkingLevel: invoke(RPC_NAMESPACES.settings.SET_DEFAULT_THINKING_LEVEL),
  getNetworkProxySettings: invoke(RPC_NAMESPACES.settings.GET_NETWORK_PROXY),
  setNetworkProxySettings: invoke(RPC_NAMESPACES.settings.SET_NETWORK_PROXY),

  // Pi provider discovery
  getPiApiKeyProviders: invoke(RPC_NAMESPACES.pi.GET_API_KEY_PROVIDERS),
  getPiProviderBaseUrl: invoke(RPC_NAMESPACES.pi.GET_PROVIDER_BASE_URL),
  getPiProviderModels: invoke(RPC_NAMESPACES.pi.GET_PROVIDER_MODELS),
  detectHermesInstallation: invoke(RPC_NAMESPACES.hermes.DETECT_INSTALLATION),
  getHermesRuntimeDetails: invoke(RPC_NAMESPACES.hermes.GET_RUNTIME_DETAILS),
  startHermesDashboard: invoke(RPC_NAMESPACES.hermes.START_DASHBOARD),
  updateHermesRuntime: invoke(RPC_NAMESPACES.hermes.UPDATE_RUNTIME),
  listHermesLogs: invoke(RPC_NAMESPACES.hermes.LIST_LOGS),
  readHermesLog: invoke(RPC_NAMESPACES.hermes.READ_LOG),
  listHermesHomeFiles: invoke(RPC_NAMESPACES.hermes.LIST_HOME_FILES),
  listHermesSkills: invoke(RPC_NAMESPACES.hermes.LIST_SKILLS),
  openHermesPath: invoke(RPC_NAMESPACES.hermes.OPEN_PATH),
  getHermesApiConfig: invoke(RPC_NAMESPACES.hermes.GET_API_CONFIG),
  patchHermesApiConfig: invoke(RPC_NAMESPACES.hermes.PATCH_API_CONFIG),
  getHermesProviderModels: invoke(RPC_NAMESPACES.hermes.GET_PROVIDER_MODELS),
  listHermesProfiles: invoke(RPC_NAMESPACES.hermes.LIST_PROFILES),
  getActiveHermesProfile: invoke(RPC_NAMESPACES.hermes.GET_ACTIVE_PROFILE),
  setActiveHermesProfile: invoke(RPC_NAMESPACES.hermes.SET_ACTIVE_PROFILE),
  createHermesProfile: invoke(RPC_NAMESPACES.hermes.CREATE_PROFILE),
  renameHermesProfile: invoke(RPC_NAMESPACES.hermes.RENAME_PROFILE),
  deleteHermesProfile: invoke(RPC_NAMESPACES.hermes.DELETE_PROFILE),
  getHermesProfileSetupCommand: invoke(RPC_NAMESPACES.hermes.GET_PROFILE_SETUP_COMMAND),
  getHermesProfileSoul: invoke(RPC_NAMESPACES.hermes.GET_PROFILE_SOUL),
  updateHermesProfileSoul: invoke(RPC_NAMESPACES.hermes.UPDATE_PROFILE_SOUL),
  listHermesEnv: invoke(RPC_NAMESPACES.hermes.LIST_ENV),
  setHermesEnv: invoke(RPC_NAMESPACES.hermes.SET_ENV),
  deleteHermesEnv: invoke(RPC_NAMESPACES.hermes.DELETE_ENV),

  // Session-specific model
  getSessionModel: invoke(RPC_NAMESPACES.sessions.GET_MODEL),
  setSessionModel: invoke(RPC_NAMESPACES.sessions.SET_MODEL),

  // Workspace Settings
  getWorkspaceSettings: invoke(RPC_NAMESPACES.workspace.SETTINGS_GET),
  updateWorkspaceSetting: invoke(RPC_NAMESPACES.workspace.SETTINGS_UPDATE),

  // Folder dialog
  openFolderDialog: invoke(RPC_NAMESPACES.dialog.OPEN_FOLDER),

  // Filesystem search
  searchFiles: invoke(RPC_NAMESPACES.fs.SEARCH),

  // Server filesystem browsing (remote mode)
  listServerDirectory: invoke(RPC_NAMESPACES.fs.LIST_DIRECTORY),
  listFileTree: invoke(RPC_NAMESPACES.fs.LIST_TREE),

  // Debug logging
  debugLog: invoke(RPC_NAMESPACES.debug.LOG),

  // User Preferences
  readPreferences: invoke(RPC_NAMESPACES.preferences.READ),
  writePreferences: invoke(RPC_NAMESPACES.preferences.WRITE),

  // Session Drafts
  getDraft: invoke(RPC_NAMESPACES.drafts.GET),
  setDraft: invoke(RPC_NAMESPACES.drafts.SET),
  deleteDraft: invoke(RPC_NAMESPACES.drafts.DELETE),
  getAllDrafts: invoke(RPC_NAMESPACES.drafts.GET_ALL),

  // Session Info Panel
  getSessionFiles: invoke(RPC_NAMESPACES.sessions.GET_FILES),
  getSessionNotes: invoke(RPC_NAMESPACES.sessions.GET_NOTES),
  setSessionNotes: invoke(RPC_NAMESPACES.sessions.SET_NOTES),
  watchSessionFiles: invoke(RPC_NAMESPACES.sessions.WATCH_FILES),
  unwatchSessionFiles: invoke(RPC_NAMESPACES.sessions.UNWATCH_FILES),
  onSessionFilesChanged: listener(RPC_NAMESPACES.sessions.FILES_CHANGED),

  // Sources
  getSources: invoke(RPC_NAMESPACES.sources.GET),
  createSource: invoke(RPC_NAMESPACES.sources.CREATE),
  deleteSource: invoke(RPC_NAMESPACES.sources.DELETE),
  startSourceOAuth: invoke(RPC_NAMESPACES.sources.START_OAUTH),
  saveSourceCredentials: invoke(RPC_NAMESPACES.sources.SAVE_CREDENTIALS),
  getSourcePermissionsConfig: invoke(RPC_NAMESPACES.sources.GET_PERMISSIONS),
  getWorkspacePermissionsConfig: invoke(RPC_NAMESPACES.workspace.GET_PERMISSIONS),
  getDefaultPermissionsConfig: invoke(RPC_NAMESPACES.permissions.GET_DEFAULTS),
  onDefaultPermissionsChanged: listener(RPC_NAMESPACES.permissions.DEFAULTS_CHANGED),
  getMcpTools: invoke(RPC_NAMESPACES.sources.GET_MCP_TOOLS),

  // Session content search
  searchSessionContent: invoke(RPC_NAMESPACES.sessions.SEARCH_CONTENT),

  // OAuth (server-owned credentials)
  oauthRevoke: invoke(RPC_NAMESPACES.oauth.REVOKE),

  // Sources change listener
  onSourcesChanged: listener(RPC_NAMESPACES.sources.CHANGED),

  // Skills
  getSkills: invoke(RPC_NAMESPACES.skills.GET),
  getSkillFiles: invoke(RPC_NAMESPACES.skills.GET_FILES),
  deleteSkill: invoke(RPC_NAMESPACES.skills.DELETE),
  openSkillInEditor: invoke(RPC_NAMESPACES.skills.OPEN_EDITOR),
  openSkillInFinder: invoke(RPC_NAMESPACES.skills.OPEN_FINDER),
  onSkillsChanged: listener(RPC_NAMESPACES.skills.CHANGED),

  // Statuses
  listStatuses: invoke(RPC_NAMESPACES.statuses.LIST),
  reorderStatuses: invoke(RPC_NAMESPACES.statuses.REORDER),
  onStatusesChanged: listener(RPC_NAMESPACES.statuses.CHANGED),

  // Labels
  listLabels: invoke(RPC_NAMESPACES.labels.LIST),
  createLabel: invoke(RPC_NAMESPACES.labels.CREATE),
  deleteLabel: invoke(RPC_NAMESPACES.labels.DELETE),
  onLabelsChanged: listener(RPC_NAMESPACES.labels.CHANGED),

  // Channels
  listChannels: invoke(RPC_NAMESPACES.channels.LIST),
  createChannel: invoke(RPC_NAMESPACES.channels.CREATE),
  updateChannel: invoke(RPC_NAMESPACES.channels.UPDATE),
  deleteChannel: invoke(RPC_NAMESPACES.channels.DELETE),
  listChannelMessages: invoke(RPC_NAMESPACES.channels.LIST_MESSAGES),
  listChannelDispatches: invoke(RPC_NAMESPACES.channels.LIST_DISPATCHES),
  sendChannelMessage: invoke(RPC_NAMESPACES.channels.SEND_MESSAGE),
  onChannelsChanged: listener(RPC_NAMESPACES.channels.CHANGED),
  onChannelMessagesChanged: listener(RPC_NAMESPACES.channels.MESSAGES_CHANGED),

  // LLM connections change listener
  onLlmConnectionsChanged: listener(RPC_NAMESPACES.llmConnections.CHANGED),

  // Views
  listViews: invoke(RPC_NAMESPACES.views.LIST),
  saveViews: invoke(RPC_NAMESPACES.views.SAVE),

  // Tool icon mappings
  getToolIconMappings: invoke(RPC_NAMESPACES.toolIcons.GET_MAPPINGS),

  // Workspace images
  readWorkspaceImage: invoke(RPC_NAMESPACES.workspace.READ_IMAGE),
  writeWorkspaceImage: invoke(RPC_NAMESPACES.workspace.WRITE_IMAGE),

  // Theme
  getAppTheme: invoke(RPC_NAMESPACES.theme.GET_APP),
  setAppTheme: invoke(RPC_NAMESPACES.theme.SET_APP),
  loadPresetThemes: invoke(RPC_NAMESPACES.theme.GET_PRESETS),
  loadPresetTheme: invoke(RPC_NAMESPACES.theme.LOAD_PRESET),
  getColorTheme: invoke(RPC_NAMESPACES.theme.GET_COLOR_THEME),
  setColorTheme: invoke(RPC_NAMESPACES.theme.SET_COLOR_THEME),
  getWorkspaceColorTheme: invoke(RPC_NAMESPACES.theme.GET_WORKSPACE_COLOR_THEME),
  setWorkspaceColorTheme: invoke(RPC_NAMESPACES.theme.SET_WORKSPACE_COLOR_THEME),
  getAllWorkspaceThemes: invoke(RPC_NAMESPACES.theme.GET_ALL_WORKSPACE_THEMES),
  getLogoUrl: invoke(RPC_NAMESPACES.logo.GET_URL),
  onAppThemeChange: listener(RPC_NAMESPACES.theme.APP_CHANGED),
  broadcastThemePreferences: invoke(RPC_NAMESPACES.theme.BROADCAST_PREFERENCES),
  onThemePreferencesChange: listener(RPC_NAMESPACES.theme.PREFERENCES_CHANGED),
  broadcastWorkspaceThemeChange: invoke(RPC_NAMESPACES.theme.BROADCAST_WORKSPACE_THEME),
  onWorkspaceThemeChange: listener(RPC_NAMESPACES.theme.WORKSPACE_THEME_CHANGED),

  // Notifications
  showNotification: invoke(RPC_NAMESPACES.notification.SHOW),
  getNotificationsEnabled: invoke(RPC_NAMESPACES.notification.GET_ENABLED),
  setNotificationsEnabled: invoke(RPC_NAMESPACES.notification.SET_ENABLED),

  // Input settings
  getAutoCapitalisation: invoke(RPC_NAMESPACES.input.GET_AUTO_CAPITALISATION),
  setAutoCapitalisation: invoke(RPC_NAMESPACES.input.SET_AUTO_CAPITALISATION),
  getSendMessageKey: invoke(RPC_NAMESPACES.input.GET_SEND_MESSAGE_KEY),
  setSendMessageKey: invoke(RPC_NAMESPACES.input.SET_SEND_MESSAGE_KEY),
  getSpellCheck: invoke(RPC_NAMESPACES.input.GET_SPELL_CHECK),
  setSpellCheck: invoke(RPC_NAMESPACES.input.SET_SPELL_CHECK),

  // Power settings
  getKeepAwakeWhileRunning: invoke(RPC_NAMESPACES.power.GET_KEEP_AWAKE),
  setKeepAwakeWhileRunning: invoke(RPC_NAMESPACES.power.SET_KEEP_AWAKE),

  // Appearance settings
  getRichToolDescriptions: invoke(RPC_NAMESPACES.appearance.GET_RICH_TOOL_DESCRIPTIONS),
  setRichToolDescriptions: invoke(RPC_NAMESPACES.appearance.SET_RICH_TOOL_DESCRIPTIONS),
  getAutoExpandActivities: invoke(RPC_NAMESPACES.appearance.GET_AUTO_EXPAND_ACTIVITIES),
  setAutoExpandActivities: invoke(RPC_NAMESPACES.appearance.SET_AUTO_EXPAND_ACTIVITIES),

  // Tools settings
  getBrowserToolEnabled: invoke(RPC_NAMESPACES.tools.GET_BROWSER_TOOL_ENABLED),
  setBrowserToolEnabled: invoke(RPC_NAMESPACES.tools.SET_BROWSER_TOOL_ENABLED),

  // Prompt caching & context
  getExtendedPromptCache: invoke(RPC_NAMESPACES.caching.GET_EXTENDED_PROMPT_CACHE),
  setExtendedPromptCache: invoke(RPC_NAMESPACES.caching.SET_EXTENDED_PROMPT_CACHE),
  getEnable1MContext: invoke(RPC_NAMESPACES.caching.GET_ENABLE_1M_CONTEXT),
  setEnable1MContext: invoke(RPC_NAMESPACES.caching.SET_ENABLE_1M_CONTEXT),

  // RTK Bash-output compression (opt-in; requires the `rtk` binary on PATH)
  getRtkEnabled: invoke(RPC_NAMESPACES.rtk.GET_ENABLED),
  setRtkEnabled: invoke(RPC_NAMESPACES.rtk.SET_ENABLED),
  getRtkStatus: invoke(RPC_NAMESPACES.rtk.GET_STATUS),
  getRtkGain: invoke(RPC_NAMESPACES.rtk.GET_GAIN),

  // Badge
  refreshBadge: invoke(RPC_NAMESPACES.badge.REFRESH),
  setDockIconWithBadge: invoke(RPC_NAMESPACES.badge.SET_ICON),
  onBadgeDraw: listener(RPC_NAMESPACES.badge.DRAW),
  onBadgeDrawWindows: listener(RPC_NAMESPACES.badge.DRAW_WINDOWS),

  // Window focus
  getWindowFocusState: invoke(RPC_NAMESPACES.window.GET_FOCUS_STATE),
  onWindowFocusChange: listener(RPC_NAMESPACES.window.FOCUS_STATE),
  onNotificationNavigate: listener(RPC_NAMESPACES.notification.NAVIGATE),

  // Git
  getGitBranch: invoke(RPC_NAMESPACES.git.GET_BRANCH),
  checkGitBash: invoke(RPC_NAMESPACES.gitbash.CHECK),
  browseForGitBash: invoke(RPC_NAMESPACES.gitbash.BROWSE),
  setGitBashPath: invoke(RPC_NAMESPACES.gitbash.SET_PATH),

  // Menu actions
  menuQuit: invoke(RPC_NAMESPACES.menu.QUIT),
  menuNewWindow: invoke(RPC_NAMESPACES.menu.NEW_WINDOW),
  menuMinimize: invoke(RPC_NAMESPACES.menu.MINIMIZE),
  menuMaximize: invoke(RPC_NAMESPACES.menu.MAXIMIZE),
  menuZoomIn: invoke(RPC_NAMESPACES.menu.ZOOM_IN),
  menuZoomOut: invoke(RPC_NAMESPACES.menu.ZOOM_OUT),
  menuZoomReset: invoke(RPC_NAMESPACES.menu.ZOOM_RESET),
  menuToggleDevTools: invoke(RPC_NAMESPACES.menu.TOGGLE_DEV_TOOLS),
  menuUndo: invoke(RPC_NAMESPACES.menu.UNDO),
  menuRedo: invoke(RPC_NAMESPACES.menu.REDO),
  menuCut: invoke(RPC_NAMESPACES.menu.CUT),
  menuCopy: invoke(RPC_NAMESPACES.menu.COPY),
  menuPaste: invoke(RPC_NAMESPACES.menu.PASTE),
  menuSelectAll: invoke(RPC_NAMESPACES.menu.SELECT_ALL),

  // Meetings MVP
  'meetings.start': invoke(RPC_NAMESPACES.meetings.START),
  'meetings.list': invoke(RPC_NAMESPACES.meetings.LIST),
  'meetings.status': invoke(RPC_NAMESPACES.meetings.STATUS),
  'meetings.stop': invoke(RPC_NAMESPACES.meetings.STOP),
  'meetings.transcript': invoke(RPC_NAMESPACES.meetings.TRANSCRIPT),
  'meetings.getTranscriptionConfig': invoke(RPC_NAMESPACES.meetings.GET_TRANSCRIPTION_CONFIG),
  'meetings.saveTranscriptionConfig': invoke(RPC_NAMESPACES.meetings.SAVE_TRANSCRIPTION_CONFIG),
  'meetings.archive': invoke(RPC_NAMESPACES.meetings.ARCHIVE),
  'meetings.unarchive': invoke(RPC_NAMESPACES.meetings.UNARCHIVE),
  'meetings.deleteMeeting': invoke(RPC_NAMESPACES.meetings.DELETE),

  // Browser pane management
  'browserPane.create': invoke(RPC_NAMESPACES.browserPane.CREATE),
  'browserPane.destroy': invoke(RPC_NAMESPACES.browserPane.DESTROY),
  'browserPane.list': invoke(RPC_NAMESPACES.browserPane.LIST),
  'browserPane.navigate': invoke(RPC_NAMESPACES.browserPane.NAVIGATE),
  'browserPane.goBack': invoke(RPC_NAMESPACES.browserPane.GO_BACK),
  'browserPane.goForward': invoke(RPC_NAMESPACES.browserPane.GO_FORWARD),
  'browserPane.reload': invoke(RPC_NAMESPACES.browserPane.RELOAD),
  'browserPane.stop': invoke(RPC_NAMESPACES.browserPane.STOP),
  'browserPane.focus': invoke(RPC_NAMESPACES.browserPane.FOCUS),
  'browserPane.emptyStateLaunch': invoke(RPC_NAMESPACES.browserPane.LAUNCH),
  'browserPane.onStateChanged': listener(RPC_NAMESPACES.browserPane.STATE_CHANGED),
  'browserPane.onRemoved': listener(RPC_NAMESPACES.browserPane.REMOVED),
  'browserPane.onInteracted': listener(RPC_NAMESPACES.browserPane.INTERACTED),
  'browserPane.listProfiles': invoke(RPC_NAMESPACES.browserPane.LIST_PROFILES),
  'browserPane.getProfileSettings': invoke(RPC_NAMESPACES.browserPane.GET_PROFILE_SETTINGS),
  'browserPane.setProfileSettings': invoke(RPC_NAMESPACES.browserPane.SET_PROFILE_SETTINGS),
  'browserPane.createProfile': invoke(RPC_NAMESPACES.browserPane.CREATE_PROFILE),
  'browserPane.importCookies': invoke(RPC_NAMESPACES.browserPane.IMPORT_COOKIES),
  'browserPane.renameProfile': invoke(RPC_NAMESPACES.browserPane.RENAME_PROFILE),
  'browserPane.switchProfile': invoke(RPC_NAMESPACES.browserPane.SWITCH_PROFILE),
  'browserPane.deleteProfile': invoke(RPC_NAMESPACES.browserPane.DELETE_PROFILE),
  'browserPane.onProfilesChanged': listener(RPC_NAMESPACES.browserPane.PROFILES_CHANGED),
  'browserPane.onPickerRequested': listener(RPC_NAMESPACES.browserPane.PICKER_REQUESTED),

  // LLM Connections
  listLlmConnections: invoke(RPC_NAMESPACES.llmConnections.LIST),
  listLlmConnectionsWithStatus: invoke(RPC_NAMESPACES.llmConnections.LIST_WITH_STATUS),
  getLlmConnection: invoke(RPC_NAMESPACES.llmConnections.GET),
  getLlmConnectionApiKey: invoke(RPC_NAMESPACES.llmConnections.GET_API_KEY),
  saveLlmConnection: invoke(RPC_NAMESPACES.llmConnections.SAVE),
  deleteLlmConnection: invoke(RPC_NAMESPACES.llmConnections.DELETE),
  testLlmConnection: invoke(RPC_NAMESPACES.llmConnections.TEST),
  setDefaultLlmConnection: invoke(RPC_NAMESPACES.llmConnections.SET_DEFAULT),
  setWorkspaceDefaultLlmConnection: invoke(RPC_NAMESPACES.llmConnections.SET_WORKSPACE_DEFAULT),

  // Projects
  getProjects: invoke(RPC_NAMESPACES.projects.GET),
  getProject: invoke(RPC_NAMESPACES.projects.GET_ONE),
  createProject: invoke(RPC_NAMESPACES.projects.CREATE),
  updateProject: invoke(RPC_NAMESPACES.projects.UPDATE),
  deleteProject: invoke(RPC_NAMESPACES.projects.DELETE),
  listProjectAssets: invoke(RPC_NAMESPACES.projects.LIST_ASSETS),
  uploadProjectAsset: invoke(RPC_NAMESPACES.projects.UPLOAD_ASSET),
  deleteProjectAsset: invoke(RPC_NAMESPACES.projects.DELETE_ASSET),
  onProjectsChanged: listener(RPC_NAMESPACES.projects.CHANGED),

  // Automations
  getAutomations: invoke(RPC_NAMESPACES.automations.GET),
  testAutomation: invoke(RPC_NAMESPACES.automations.TEST),
  setAutomationEnabled: invoke(RPC_NAMESPACES.automations.SET_ENABLED),
  duplicateAutomation: invoke(RPC_NAMESPACES.automations.DUPLICATE),
  deleteAutomation: invoke(RPC_NAMESPACES.automations.DELETE),
  getAutomationHistory: invoke(RPC_NAMESPACES.automations.GET_HISTORY),
  getAutomationLastExecuted: invoke(RPC_NAMESPACES.automations.GET_LAST_EXECUTED),
  replayAutomation: invoke(RPC_NAMESPACES.automations.REPLAY),
  onAutomationsChanged: listener(RPC_NAMESPACES.automations.CHANGED),

  // Resources (cross-workspace export/import)
  exportResources: invoke(RPC_NAMESPACES.resources.EXPORT),
  importResources: invoke(RPC_NAMESPACES.resources.IMPORT),

  // Messaging gateway
  getMessagingConfig: invoke(RPC_NAMESPACES.messaging.GET_CONFIG),
  updateMessagingConfig: invoke(RPC_NAMESPACES.messaging.UPDATE_CONFIG),
  testTelegramToken: invoke(RPC_NAMESPACES.messaging.TEST_TELEGRAM),
  saveTelegramToken: invoke(RPC_NAMESPACES.messaging.SAVE_TELEGRAM),
  saveLarkCredentials: invoke(RPC_NAMESPACES.messaging.SAVE_LARK),
  disconnectMessagingPlatform: invoke(RPC_NAMESPACES.messaging.DISCONNECT),
  forgetMessagingPlatform: invoke(RPC_NAMESPACES.messaging.FORGET),
  getMessagingBindings: invoke(RPC_NAMESPACES.messaging.GET_BINDINGS),
  generateMessagingPairingCode: invoke(RPC_NAMESPACES.messaging.GENERATE_CODE),
  generateMessagingSupergroupCode: invoke(RPC_NAMESPACES.messaging.GENERATE_SUPERGROUP_CODE),
  getMessagingSupergroup: invoke(RPC_NAMESPACES.messaging.GET_SUPERGROUP),
  unbindMessagingSupergroup: invoke(RPC_NAMESPACES.messaging.UNBIND_SUPERGROUP),
  unbindMessagingSession: invoke(RPC_NAMESPACES.messaging.UNBIND),
  unbindMessagingBinding: invoke(RPC_NAMESPACES.messaging.UNBIND_BINDING),
  onMessagingBindingChanged: listener(RPC_NAMESPACES.messaging.BINDING_CHANGED),
  onMessagingPlatformStatus: listener(RPC_NAMESPACES.messaging.PLATFORM_STATUS),
  startWhatsAppConnect: invoke(RPC_NAMESPACES.messaging.WA_START_CONNECT),
  submitWhatsAppPhone: invoke(RPC_NAMESPACES.messaging.WA_SUBMIT_PHONE),
  onWhatsAppEvent: listener(RPC_NAMESPACES.messaging.WA_UI_EVENT),

  // Messaging access control
  getMessagingPlatformOwners: invoke(RPC_NAMESPACES.messaging.GET_PLATFORM_OWNERS),
  setMessagingPlatformOwners: invoke(RPC_NAMESPACES.messaging.SET_PLATFORM_OWNERS),
  getMessagingPlatformAccessMode: invoke(RPC_NAMESPACES.messaging.GET_PLATFORM_ACCESS_MODE),
  setMessagingPlatformAccessMode: invoke(RPC_NAMESPACES.messaging.SET_PLATFORM_ACCESS_MODE),
  getMessagingPendingSenders: invoke(RPC_NAMESPACES.messaging.GET_PENDING_SENDERS),
  dismissMessagingPendingSender: invoke(RPC_NAMESPACES.messaging.DISMISS_PENDING_SENDER),
  allowMessagingPendingSender: invoke(RPC_NAMESPACES.messaging.ALLOW_PENDING_SENDER),
  setMessagingBindingAccess: invoke(RPC_NAMESPACES.messaging.SET_BINDING_ACCESS),
  onMessagingPendingChanged: listener(RPC_NAMESPACES.messaging.PENDING_CHANGED),
} satisfies ChannelMap
