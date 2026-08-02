/**
 * IPC channel names for the browser toolbar preload bridge.
 *
 * Single source shared by the main-process host (`BrowserPaneManager` /
 * `toolbar-host`) and the preload bridge (`preload/browser-toolbar.ts`). Keeping
 * one copy prevents the two ends from silently drifting on a channel string.
 */
export const TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
  REQUEST_PROFILE_MANAGEMENT: 'browser-toolbar:request-profile-management',
  SWITCH_PROFILE: 'browser-toolbar:switch-profile',
  /** Toggle the session panel embedded on the right of this browser's page. */
  TOGGLE_SESSION_PANEL: 'browser-toolbar:toggle-session-panel',
} as const
