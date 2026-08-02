/**
 * Exhaustive channel routing table for hybrid local/remote transport.
 *
 * Every RPC channel must belong to exactly one of two sets:
 * - LOCAL_ONLY: Always runs on the local Electron server, never proxied.
 * - REMOTE_ELIGIBLE: Runs on whichever server owns the workspace.
 *
 * An exhaustiveness test ensures new channels fail CI until classified.
 */

import { RPC_NAMESPACES } from './channels'

// ---------------------------------------------------------------------------
// LOCAL_ONLY — fundamentally requires local OS / Electron
// ---------------------------------------------------------------------------

export const LOCAL_ONLY_NAMESPACES = new Set<string>([
  // remote — local connectivity management (reaches out to remote server from local app)
  RPC_NAMESPACES.remote.TEST_CONNECTION,

  // workspaces — local workspace CRUD (workspace list is local config)
  RPC_NAMESPACES.workspaces.GET,
  RPC_NAMESPACES.workspaces.CREATE,
  RPC_NAMESPACES.workspaces.CHECK_SLUG,
  RPC_NAMESPACES.workspaces.UPDATE_REMOTE,
  RPC_NAMESPACES.workspaces.GET_DEFAULT,
  RPC_NAMESPACES.workspaces.SET_DEFAULT,

  // window — Electron window management
  RPC_NAMESPACES.window.GET_WORKSPACE,
  RPC_NAMESPACES.window.GET_MODE,
  RPC_NAMESPACES.window.OPEN_WORKSPACE,
  RPC_NAMESPACES.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_NAMESPACES.window.SWITCH_WORKSPACE,
  RPC_NAMESPACES.window.CLOSE,
  RPC_NAMESPACES.window.CLOSE_REQUESTED,
  RPC_NAMESPACES.window.CONFIRM_CLOSE,
  RPC_NAMESPACES.window.CANCEL_CLOSE,
  RPC_NAMESPACES.window.SET_TRAFFIC_LIGHTS,
  RPC_NAMESPACES.window.FOCUS_STATE,
  RPC_NAMESPACES.window.GET_FOCUS_STATE,

  // file — native file dialog
  RPC_NAMESPACES.file.OPEN_DIALOG,
  // file — draft hydration for user-attached paths. Paths in drafts.json were captured
  // via webUtils.getPathForFile in the renderer, so they point at the user's local machine
  // — even when the workspace itself lives on a remote server. Routing this REMOTE_ELIGIBLE
  // would send the local path to a remote filesystem that can't resolve it.
  RPC_NAMESPACES.file.READ_USER_ATTACHMENT,

  // dialog — native folder dialog
  RPC_NAMESPACES.dialog.OPEN_FOLDER,

  // auth — local auth state + native dialogs
  RPC_NAMESPACES.auth.LOGOUT,
  RPC_NAMESPACES.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_NAMESPACES.auth.SHOW_DELETE_SESSION_CONFIRMATION,

  // shell — local OS shell (openFile/showInFolder guarded for remote)
  RPC_NAMESPACES.shell.OPEN_URL,
  RPC_NAMESPACES.shell.OPEN_FILE,
  RPC_NAMESPACES.shell.SHOW_IN_FOLDER,

  // skills — local filesystem actions (guarded for remote)
  RPC_NAMESPACES.skills.OPEN_EDITOR,
  RPC_NAMESPACES.skills.OPEN_FINDER,

  // system — local OS info
  RPC_NAMESPACES.system.VERSIONS,
  RPC_NAMESPACES.system.HOME_DIR,
  RPC_NAMESPACES.system.IS_DEBUG_MODE,

  // theme — app/OS-level preferences, not workspace content
  RPC_NAMESPACES.theme.GET_SYSTEM_PREFERENCE,
  RPC_NAMESPACES.theme.SYSTEM_CHANGED,
  RPC_NAMESPACES.theme.APP_CHANGED,
  RPC_NAMESPACES.theme.GET_APP,
  RPC_NAMESPACES.theme.SET_APP,
  RPC_NAMESPACES.theme.GET_PRESETS,
  RPC_NAMESPACES.theme.LOAD_PRESET,
  RPC_NAMESPACES.theme.GET_COLOR_THEME,
  RPC_NAMESPACES.theme.SET_COLOR_THEME,
  RPC_NAMESPACES.theme.BROADCAST_PREFERENCES,
  RPC_NAMESPACES.theme.PREFERENCES_CHANGED,
  RPC_NAMESPACES.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_NAMESPACES.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_NAMESPACES.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_NAMESPACES.theme.BROADCAST_WORKSPACE_THEME,
  RPC_NAMESPACES.theme.WORKSPACE_THEME_CHANGED,

  // update — local auto-update
  RPC_NAMESPACES.update.CHECK,
  RPC_NAMESPACES.update.GET_INFO,
  RPC_NAMESPACES.update.INSTALL,
  RPC_NAMESPACES.update.DISMISS,
  RPC_NAMESPACES.update.GET_DISMISSED,
  RPC_NAMESPACES.update.AVAILABLE,
  RPC_NAMESPACES.update.DOWNLOAD_PROGRESS,

  // releaseNotes — local app info
  RPC_NAMESPACES.releaseNotes.GET,
  RPC_NAMESPACES.releaseNotes.GET_LATEST_VERSION,

  // badge — local dock badge
  RPC_NAMESPACES.badge.REFRESH,
  RPC_NAMESPACES.badge.SET_ICON,
  RPC_NAMESPACES.badge.DRAW,
  RPC_NAMESPACES.badge.DRAW_WINDOWS,

  // menu — local menu events
  RPC_NAMESPACES.menu.NEW_CHAT,
  RPC_NAMESPACES.menu.NEW_WINDOW,
  RPC_NAMESPACES.menu.OPEN_SETTINGS,
  RPC_NAMESPACES.menu.KEYBOARD_SHORTCUTS,
  RPC_NAMESPACES.menu.TOGGLE_FOCUS_MODE,
  RPC_NAMESPACES.menu.TOGGLE_SIDEBAR,
  RPC_NAMESPACES.menu.QUIT,
  RPC_NAMESPACES.menu.MINIMIZE,
  RPC_NAMESPACES.menu.MAXIMIZE,
  RPC_NAMESPACES.menu.ZOOM_IN,
  RPC_NAMESPACES.menu.ZOOM_OUT,
  RPC_NAMESPACES.menu.ZOOM_RESET,
  RPC_NAMESPACES.menu.TOGGLE_DEV_TOOLS,
  RPC_NAMESPACES.menu.UNDO,
  RPC_NAMESPACES.menu.REDO,
  RPC_NAMESPACES.menu.CUT,
  RPC_NAMESPACES.menu.COPY,
  RPC_NAMESPACES.menu.PASTE,
  RPC_NAMESPACES.menu.SELECT_ALL,

  // deeplink — local deep link handling
  RPC_NAMESPACES.deeplink.NAVIGATE,

  // notification — local OS notifications
  RPC_NAMESPACES.notification.SHOW,
  RPC_NAMESPACES.notification.NAVIGATE,
  RPC_NAMESPACES.notification.GET_ENABLED,
  RPC_NAMESPACES.notification.SET_ENABLED,

  // input — local input preferences
  RPC_NAMESPACES.input.GET_AUTO_CAPITALISATION,
  RPC_NAMESPACES.input.SET_AUTO_CAPITALISATION,
  RPC_NAMESPACES.input.GET_SEND_MESSAGE_KEY,
  RPC_NAMESPACES.input.SET_SEND_MESSAGE_KEY,
  RPC_NAMESPACES.input.GET_SPELL_CHECK,
  RPC_NAMESPACES.input.SET_SPELL_CHECK,

  // power — local power management
  RPC_NAMESPACES.power.GET_KEEP_AWAKE,
  RPC_NAMESPACES.power.SET_KEEP_AWAKE,

  // appearance — local UI preferences
  RPC_NAMESPACES.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_NAMESPACES.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_NAMESPACES.appearance.GET_AUTO_EXPAND_ACTIVITIES,
  RPC_NAMESPACES.appearance.SET_AUTO_EXPAND_ACTIVITIES,

  // caching — prompt cache and context settings
  RPC_NAMESPACES.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_NAMESPACES.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_NAMESPACES.caching.GET_ENABLE_1M_CONTEXT,
  RPC_NAMESPACES.caching.SET_ENABLE_1M_CONTEXT,

  // rtk — token-optimization opt-in
  RPC_NAMESPACES.rtk.GET_ENABLED,
  RPC_NAMESPACES.rtk.SET_ENABLED,
  RPC_NAMESPACES.rtk.GET_STATUS,
  RPC_NAMESPACES.rtk.GET_GAIN,

  // tools — local tool settings
  RPC_NAMESPACES.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_NAMESPACES.tools.SET_BROWSER_TOOL_ENABLED,

  // browserPane — Electron BrowserView
  RPC_NAMESPACES.browserPane.CREATE,
  RPC_NAMESPACES.browserPane.DESTROY,
  RPC_NAMESPACES.browserPane.LIST,
  RPC_NAMESPACES.browserPane.NAVIGATE,
  RPC_NAMESPACES.browserPane.GO_BACK,
  RPC_NAMESPACES.browserPane.GO_FORWARD,
  RPC_NAMESPACES.browserPane.RELOAD,
  RPC_NAMESPACES.browserPane.STOP,
  RPC_NAMESPACES.browserPane.FOCUS,
  RPC_NAMESPACES.browserPane.SNAPSHOT,
  RPC_NAMESPACES.browserPane.CLICK,
  RPC_NAMESPACES.browserPane.FILL,
  RPC_NAMESPACES.browserPane.SELECT,
  RPC_NAMESPACES.browserPane.SCREENSHOT,
  RPC_NAMESPACES.browserPane.EVALUATE,
  RPC_NAMESPACES.browserPane.SCROLL,
  RPC_NAMESPACES.browserPane.LAUNCH,
  // Display mode is a desktop-only concern: it moves native views between the
  // instance window and a host window, which has no meaning for remote panes.
  RPC_NAMESPACES.browserPane.SET_DISPLAY_MODE,
  RPC_NAMESPACES.browserPane.SET_EMBEDDED_BOUNDS,
  RPC_NAMESPACES.browserPane.STATE_CHANGED,
  RPC_NAMESPACES.browserPane.REMOVED,
  RPC_NAMESPACES.browserPane.INTERACTED,
  RPC_NAMESPACES.browserPane.LIST_PROFILES,
  RPC_NAMESPACES.browserPane.CREATE_PROFILE,
  RPC_NAMESPACES.browserPane.DELETE_PROFILE,
  RPC_NAMESPACES.browserPane.RENAME_PROFILE,
  RPC_NAMESPACES.browserPane.SWITCH_PROFILE,
  RPC_NAMESPACES.browserPane.GET_PROFILE_SETTINGS,
  RPC_NAMESPACES.browserPane.SET_PROFILE_SETTINGS,
  RPC_NAMESPACES.browserPane.PROFILES_CHANGED,
  RPC_NAMESPACES.browserPane.PICKER_REQUESTED,
  RPC_NAMESPACES.browserPane.DISPLAY_MODE_REQUESTED,

  // gitbash — Windows-specific local
  RPC_NAMESPACES.gitbash.CHECK,
  RPC_NAMESPACES.gitbash.BROWSE,
  RPC_NAMESPACES.gitbash.SET_PATH,

  // debug — local debug logging
  RPC_NAMESPACES.debug.LOG,

  // onboarding — local auth setup flow
  RPC_NAMESPACES.onboarding.GET_AUTH_STATE,
  RPC_NAMESPACES.onboarding.VALIDATE_MCP,
  RPC_NAMESPACES.onboarding.START_MCP_OAUTH,
  RPC_NAMESPACES.onboarding.DEFER_SETUP,
  RPC_NAMESPACES.settings.GET_NETWORK_PROXY,
  RPC_NAMESPACES.settings.SET_NETWORK_PROXY,

  // server config — local embedded server settings
  RPC_NAMESPACES.settings.GET_SERVER_CONFIG,
  RPC_NAMESPACES.settings.SET_SERVER_CONFIG,
  RPC_NAMESPACES.settings.GET_SERVER_STATUS,

  // hermes — local runtime/dashboard control
  RPC_NAMESPACES.hermes.DETECT_INSTALLATION,
  RPC_NAMESPACES.hermes.GET_RUNTIME_DETAILS,
  RPC_NAMESPACES.hermes.START_DASHBOARD,
  RPC_NAMESPACES.hermes.UPDATE_RUNTIME,
  RPC_NAMESPACES.hermes.LIST_LOGS,
  RPC_NAMESPACES.hermes.READ_LOG,
  RPC_NAMESPACES.hermes.LIST_HOME_FILES,
  RPC_NAMESPACES.hermes.LIST_SKILLS,
  RPC_NAMESPACES.hermes.OPEN_PATH,
  RPC_NAMESPACES.hermes.GET_API_CONFIG,
  RPC_NAMESPACES.hermes.PATCH_API_CONFIG,
  RPC_NAMESPACES.hermes.GET_PROVIDER_MODELS,
  RPC_NAMESPACES.hermes.LIST_PROFILES,
  RPC_NAMESPACES.hermes.GET_ACTIVE_PROFILE,
  RPC_NAMESPACES.hermes.SET_ACTIVE_PROFILE,
  RPC_NAMESPACES.hermes.CREATE_PROFILE,
  RPC_NAMESPACES.hermes.RENAME_PROFILE,
  RPC_NAMESPACES.hermes.DELETE_PROFILE,
  RPC_NAMESPACES.hermes.GET_PROFILE_SETUP_COMMAND,
  RPC_NAMESPACES.hermes.GET_PROFILE_SOUL,
  RPC_NAMESPACES.hermes.UPDATE_PROFILE_SOUL,
  RPC_NAMESPACES.hermes.LIST_ENV,
  RPC_NAMESPACES.hermes.SET_ENV,
  RPC_NAMESPACES.hermes.DELETE_ENV,

  // meetings — local Electron BrowserView-backed meeting control
  RPC_NAMESPACES.meetings.START,
  RPC_NAMESPACES.meetings.LIST,
  RPC_NAMESPACES.meetings.STATUS,
  RPC_NAMESPACES.meetings.STOP,
  RPC_NAMESPACES.meetings.TRANSCRIPT,
  RPC_NAMESPACES.meetings.GET_TRANSCRIPTION_CONFIG,
  RPC_NAMESPACES.meetings.SAVE_TRANSCRIPTION_CONFIG,
  RPC_NAMESPACES.meetings.ARCHIVE,
  RPC_NAMESPACES.meetings.UNARCHIVE,
  RPC_NAMESPACES.meetings.DELETE,
])

// ---------------------------------------------------------------------------
// REMOTE_ELIGIBLE — runs on whichever server owns the workspace
// ---------------------------------------------------------------------------

export const REMOTE_ELIGIBLE_NAMESPACES = new Set<string>([
  // server — server-level operations (no workspace context needed)
  RPC_NAMESPACES.server.GET_WORKSPACES,
  RPC_NAMESPACES.server.CREATE_WORKSPACE,
  RPC_NAMESPACES.server.GET_STATUS,
  RPC_NAMESPACES.server.GET_HEALTH,
  RPC_NAMESPACES.server.GET_ACTIVE_SESSIONS,
  RPC_NAMESPACES.server.SHUTTING_DOWN,
  RPC_NAMESPACES.server.STATUS_CHANGED,
  RPC_NAMESPACES.server.HOME_DIR,

  // sessions — core session runtime
  RPC_NAMESPACES.sessions.GET,
  RPC_NAMESPACES.sessions.GET_UNREAD_SUMMARY,
  RPC_NAMESPACES.sessions.MARK_ALL_READ,
  RPC_NAMESPACES.sessions.UNREAD_SUMMARY_CHANGED,
  RPC_NAMESPACES.sessions.CREATE,
  RPC_NAMESPACES.sessions.DELETE,
  RPC_NAMESPACES.sessions.GET_MESSAGES,
  RPC_NAMESPACES.sessions.SEND_MESSAGE,
  RPC_NAMESPACES.sessions.CANCEL,
  RPC_NAMESPACES.sessions.KILL_SHELL,
  RPC_NAMESPACES.sessions.RESPOND_TO_PERMISSION,
  RPC_NAMESPACES.sessions.RESPOND_TO_CREDENTIAL,
  RPC_NAMESPACES.sessions.RESPOND_TO_USER_QUESTION,
  RPC_NAMESPACES.sessions.COMMAND,
  RPC_NAMESPACES.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_NAMESPACES.sessions.GET_PERMISSION_MODE_STATE,
  RPC_NAMESPACES.sessions.EVENT,
  RPC_NAMESPACES.sessions.GET_MODEL,
  RPC_NAMESPACES.sessions.SET_MODEL,
  RPC_NAMESPACES.sessions.GET_FILES,
  RPC_NAMESPACES.sessions.GET_NOTES,
  RPC_NAMESPACES.sessions.SET_NOTES,
  RPC_NAMESPACES.sessions.WATCH_FILES,
  RPC_NAMESPACES.sessions.UNWATCH_FILES,
  RPC_NAMESPACES.sessions.FILES_CHANGED,
  RPC_NAMESPACES.sessions.SEARCH_CONTENT,
  RPC_NAMESPACES.sessions.EXPORT,
  RPC_NAMESPACES.sessions.IMPORT,
  RPC_NAMESPACES.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_NAMESPACES.sessions.IMPORT_REMOTE_TRANSFER,

  // transfer — chunked large-payload import (sessions, resources)
  RPC_NAMESPACES.transfer.START,
  RPC_NAMESPACES.transfer.CHUNK,
  RPC_NAMESPACES.transfer.COMMIT,
  RPC_NAMESPACES.transfer.ABORT,

  // tasks — workspace content
  RPC_NAMESPACES.tasks.GET_OUTPUT,
  RPC_NAMESPACES.tasks.VALIDATE,
  RPC_NAMESPACES.tasks.CREATE,
  RPC_NAMESPACES.tasks.GENERATE,
  RPC_NAMESPACES.tasks.GENERATED,
  RPC_NAMESPACES.tasks.RUN,
  RPC_NAMESPACES.tasks.PAUSE,
  RPC_NAMESPACES.tasks.RESUME,
  RPC_NAMESPACES.tasks.STOP,
  RPC_NAMESPACES.tasks.GET,
  RPC_NAMESPACES.tasks.LIST,
  RPC_NAMESPACES.tasks.GET_RESULTS,

  // projects — workspace content
  RPC_NAMESPACES.projects.GET,
  RPC_NAMESPACES.projects.GET_ONE,
  RPC_NAMESPACES.projects.CREATE,
  RPC_NAMESPACES.projects.UPDATE,
  RPC_NAMESPACES.projects.DELETE,
  RPC_NAMESPACES.projects.LIST_ASSETS,
  RPC_NAMESPACES.projects.UPLOAD_ASSET,
  RPC_NAMESPACES.projects.DELETE_ASSET,
  RPC_NAMESPACES.projects.CHANGED,

  // file — workspace files (not openDialog which is native)
  RPC_NAMESPACES.file.READ,
  RPC_NAMESPACES.file.READ_DATA_URL,
  RPC_NAMESPACES.file.READ_PREVIEW_DATA_URL,
  RPC_NAMESPACES.file.READ_BINARY,
  RPC_NAMESPACES.file.READ_ATTACHMENT,
  RPC_NAMESPACES.file.STORE_ATTACHMENT,
  RPC_NAMESPACES.file.GENERATE_THUMBNAIL,

  // fs — workspace filesystem
  RPC_NAMESPACES.fs.SEARCH,
  RPC_NAMESPACES.fs.LIST_DIRECTORY,
  RPC_NAMESPACES.fs.LIST_TREE,

  // credentials — remote server's credential state
  RPC_NAMESPACES.credentials.HEALTH_CHECK,

  // llmConnections — LLM config lives on server running workspace
  RPC_NAMESPACES.llmConnections.LIST,
  RPC_NAMESPACES.llmConnections.LIST_WITH_STATUS,
  RPC_NAMESPACES.llmConnections.GET,
  RPC_NAMESPACES.llmConnections.GET_API_KEY,
  RPC_NAMESPACES.llmConnections.SAVE,
  RPC_NAMESPACES.llmConnections.DELETE,
  RPC_NAMESPACES.llmConnections.TEST,
  RPC_NAMESPACES.llmConnections.SET_DEFAULT,
  RPC_NAMESPACES.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_NAMESPACES.llmConnections.REFRESH_MODELS,
  RPC_NAMESPACES.llmConnections.CHANGED,

  // chatgpt — OAuth via capability passthrough
  RPC_NAMESPACES.chatgpt.START_OAUTH,
  RPC_NAMESPACES.chatgpt.COMPLETE_OAUTH,
  RPC_NAMESPACES.chatgpt.CANCEL_OAUTH,
  RPC_NAMESPACES.chatgpt.GET_AUTH_STATUS,
  RPC_NAMESPACES.chatgpt.LOGOUT,

  // copilot — OAuth via capability passthrough
  RPC_NAMESPACES.copilot.START_OAUTH,
  RPC_NAMESPACES.copilot.CANCEL_OAUTH,
  RPC_NAMESPACES.copilot.GET_AUTH_STATUS,
  RPC_NAMESPACES.copilot.LOGOUT,
  RPC_NAMESPACES.copilot.DEVICE_CODE,

  // Claude OAuth — runs on workspace server so credentials and connection config
  // end up on the same server that will use them. Browser opening is client-side.
  // (ChatGPT OAuth stays LOCAL_ONLY — requires localhost callback server.)
  RPC_NAMESPACES.onboarding.START_CLAUDE_OAUTH,
  RPC_NAMESPACES.onboarding.EXCHANGE_CLAUDE_CODE,
  RPC_NAMESPACES.onboarding.HAS_CLAUDE_OAUTH_STATE,
  RPC_NAMESPACES.onboarding.CLEAR_CLAUDE_OAUTH_STATE,

  // settings — workspace-level settings
  RPC_NAMESPACES.settings.SETUP_LLM_CONNECTION,
  RPC_NAMESPACES.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_NAMESPACES.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_NAMESPACES.settings.SET_DEFAULT_THINKING_LEVEL,

  // pi — provider config on workspace server
  RPC_NAMESPACES.pi.GET_API_KEY_PROVIDERS,
  RPC_NAMESPACES.pi.GET_PROVIDER_BASE_URL,
  RPC_NAMESPACES.pi.GET_PROVIDER_MODELS,

  // preferences — workspace-level preferences
  RPC_NAMESPACES.preferences.READ,
  RPC_NAMESPACES.preferences.WRITE,

  // drafts — workspace content
  RPC_NAMESPACES.drafts.GET,
  RPC_NAMESPACES.drafts.SET,
  RPC_NAMESPACES.drafts.DELETE,
  RPC_NAMESPACES.drafts.GET_ALL,

  // sources — source config per-workspace
  RPC_NAMESPACES.sources.GET,
  RPC_NAMESPACES.sources.CREATE,
  RPC_NAMESPACES.sources.DELETE,
  RPC_NAMESPACES.sources.START_OAUTH,
  RPC_NAMESPACES.sources.SAVE_CREDENTIALS,
  RPC_NAMESPACES.sources.CHANGED,
  RPC_NAMESPACES.sources.GET_PERMISSIONS,
  RPC_NAMESPACES.sources.GET_MCP_TOOLS,

  // oauth — OAuth state management
  RPC_NAMESPACES.oauth.START,
  RPC_NAMESPACES.oauth.COMPLETE,
  RPC_NAMESPACES.oauth.CANCEL,
  RPC_NAMESPACES.oauth.REVOKE,

  // workspace — workspace config + images (sharp on headless)
  RPC_NAMESPACES.workspace.GET_PERMISSIONS,
  RPC_NAMESPACES.workspace.READ_IMAGE,
  RPC_NAMESPACES.workspace.WRITE_IMAGE,
  RPC_NAMESPACES.workspace.SETTINGS_GET,
  RPC_NAMESPACES.workspace.SETTINGS_UPDATE,

  // permissions — workspace permissions
  RPC_NAMESPACES.permissions.GET_DEFAULTS,
  RPC_NAMESPACES.permissions.DEFAULTS_CHANGED,

  // skills — skill content per-workspace (not openEditor/openFinder which are local OS)
  RPC_NAMESPACES.skills.GET,
  RPC_NAMESPACES.skills.GET_FILES,
  RPC_NAMESPACES.skills.DELETE,
  RPC_NAMESPACES.skills.CHANGED,

  // statuses — workspace metadata
  RPC_NAMESPACES.statuses.LIST,
  RPC_NAMESPACES.statuses.REORDER,
  RPC_NAMESPACES.statuses.CHANGED,

  // labels — workspace metadata
  RPC_NAMESPACES.labels.LIST,
  RPC_NAMESPACES.labels.CREATE,
  RPC_NAMESPACES.labels.DELETE,
  RPC_NAMESPACES.labels.CHANGED,

  // channels — workspace metadata backed by labels
  RPC_NAMESPACES.channels.LIST,
  RPC_NAMESPACES.channels.CREATE,
  RPC_NAMESPACES.channels.UPDATE,
  RPC_NAMESPACES.channels.DELETE,
  RPC_NAMESPACES.channels.LIST_MESSAGES,
  RPC_NAMESPACES.channels.LIST_DISPATCHES,
  RPC_NAMESPACES.channels.SEND_MESSAGE,
  RPC_NAMESPACES.channels.CHANGED,
  RPC_NAMESPACES.channels.MESSAGES_CHANGED,

  // views — workspace UI views
  RPC_NAMESPACES.views.LIST,
  RPC_NAMESPACES.views.SAVE,

  // toolIcons — workspace config
  RPC_NAMESPACES.toolIcons.GET_MAPPINGS,

  // logo — workspace config
  RPC_NAMESPACES.logo.GET_URL,

  // automations — workspace automations
  RPC_NAMESPACES.automations.GET,
  RPC_NAMESPACES.automations.TEST,
  RPC_NAMESPACES.automations.SET_ENABLED,
  RPC_NAMESPACES.automations.DUPLICATE,
  RPC_NAMESPACES.automations.DELETE,
  RPC_NAMESPACES.automations.GET_HISTORY,
  RPC_NAMESPACES.automations.GET_LAST_EXECUTED,
  RPC_NAMESPACES.automations.REPLAY,
  RPC_NAMESPACES.automations.CHANGED,

  // git — workspace filesystem
  RPC_NAMESPACES.git.GET_BRANCH,

  // resources — workspace resource export/import
  RPC_NAMESPACES.resources.EXPORT,
  RPC_NAMESPACES.resources.IMPORT,

  // messaging — gateway channels run on workspace server
  RPC_NAMESPACES.messaging.WA_REGISTER,
  RPC_NAMESPACES.messaging.WA_INCOMING,
  RPC_NAMESPACES.messaging.WA_BUTTON_PRESS,
  RPC_NAMESPACES.messaging.WA_STATUS,
  RPC_NAMESPACES.messaging.WA_QR,
  RPC_NAMESPACES.messaging.WA_SEND,
  RPC_NAMESPACES.messaging.WA_SEND_BUTTONS,
  RPC_NAMESPACES.messaging.WA_SEND_TYPING,
  RPC_NAMESPACES.messaging.WA_SEND_FILE,
  RPC_NAMESPACES.messaging.WA_CONNECT,
  RPC_NAMESPACES.messaging.WA_DISCONNECT,
  RPC_NAMESPACES.messaging.BINDING_CHANGED,
  RPC_NAMESPACES.messaging.PLATFORM_STATUS,
  RPC_NAMESPACES.messaging.PENDING_CHANGED,
  RPC_NAMESPACES.messaging.GET_CONFIG,
  RPC_NAMESPACES.messaging.UPDATE_CONFIG,
  RPC_NAMESPACES.messaging.TEST_TELEGRAM,
  RPC_NAMESPACES.messaging.SAVE_TELEGRAM,
  RPC_NAMESPACES.messaging.SAVE_LARK,
  RPC_NAMESPACES.messaging.DISCONNECT,
  RPC_NAMESPACES.messaging.FORGET,
  RPC_NAMESPACES.messaging.GET_BINDINGS,
  RPC_NAMESPACES.messaging.GENERATE_CODE,
  RPC_NAMESPACES.messaging.UNBIND,
  RPC_NAMESPACES.messaging.UNBIND_BINDING,
  RPC_NAMESPACES.messaging.GENERATE_SUPERGROUP_CODE,
  RPC_NAMESPACES.messaging.GET_SUPERGROUP,
  RPC_NAMESPACES.messaging.UNBIND_SUPERGROUP,
  RPC_NAMESPACES.messaging.WA_START_CONNECT,
  RPC_NAMESPACES.messaging.WA_SUBMIT_PHONE,
  RPC_NAMESPACES.messaging.WA_UI_EVENT,

  // messaging — access control (per-platform owners + per-binding allow-list); config lives with the gateway on the workspace server
  RPC_NAMESPACES.messaging.GET_PLATFORM_OWNERS,
  RPC_NAMESPACES.messaging.SET_PLATFORM_OWNERS,
  RPC_NAMESPACES.messaging.GET_PLATFORM_ACCESS_MODE,
  RPC_NAMESPACES.messaging.SET_PLATFORM_ACCESS_MODE,
  RPC_NAMESPACES.messaging.GET_PENDING_SENDERS,
  RPC_NAMESPACES.messaging.DISMISS_PENDING_SENDER,
  RPC_NAMESPACES.messaging.ALLOW_PENDING_SENDER,
  RPC_NAMESPACES.messaging.SET_BINDING_ACCESS,
])

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_NAMESPACES.has(channel)
}

export function isRemoteEligible(channel: string): boolean {
  return REMOTE_ELIGIBLE_NAMESPACES.has(channel)
}
