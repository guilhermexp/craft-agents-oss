/**
 * Colour painted behind a browser instance's native views.
 *
 * Three surfaces have to agree on it or the seams show:
 *  - the BrowserWindow itself, behind the views while floating;
 *  - the hole `IntegratedBrowserPanel` leaves for those views, which is what
 *    shows through wherever two rounded sibling views curve away from each
 *    other;
 *  - the new-tab page, which is browser chrome rather than app canvas.
 *
 * Deliberately its own constant instead of the app's `--background`: the app
 * canvas is near-black and the views sitting on it read as a hole punched in
 * the window. It is duplicated once more, as a literal, in the inline style of
 * `browser-empty-state.html` — that paint happens before any module loads, and
 * a mismatch there is a flash of the wrong colour on every new tab.
 */
export const BROWSER_CHROME_BG = {
  light: '#fafafb',
  dark: '#2b292e',
} as const

/**
 * Interior panel corner radius, in CSS px.
 *
 * Lives here because both sides need it and the main process cannot import
 * renderer modules: `panel-constants.RADIUS_INNER` re-exports it, and the
 * docked browser's native views must round to exactly the panel they fill.
 * A view left square paints its corner over the panel's rounded one.
 */
export const PANEL_INTERIOR_RADIUS = 10
