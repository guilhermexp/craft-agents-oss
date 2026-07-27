/**
 * BrowserThemeExtractor
 *
 * Owns theme-color derivation for browser instances: one-shot extraction, the
 * in-page MutationObserver that streams color changes back over a console
 * signal, applying/deduping the resolved color to the toolbar, and the early
 * post-navigation extraction. Extracted from BrowserPaneManager — the parent
 * retains instance lifecycle and wires page-event handlers to these methods.
 *
 * Coupling to the parent is expressed through the injected ThemeExtractorDeps
 * object rather than direct field access, so theme logic stays unit-testable.
 * The injected-JS strings (extractor fn + observer template) are behavior-
 * critical and must be kept verbatim — a single-char change breaks extraction.
 */

import { TOOLBAR_CHANNELS } from '../../shared/browser-toolbar-channels'
import type { BrowserInstance } from '../browser-pane-manager'

const THEME_COLOR_SIGNAL_PREFIX = '__craft_theme_color__:'
const THEME_COLOR_NULL_SENTINEL = '__NULL__'
const THEME_OBSERVER_MIN_INTERVAL_MS = 120
const EARLY_THEME_EXTRACTION_DELAY_MS = 100

const THEME_COLOR_EXTRACTOR_FN = String.raw`
() => {
  const toHex = (r, g, b) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    const hm = /^#([0-9a-f]{3,8})$/i.exec(str);
    if (hm) {
      const h = hm[1];
      let r, g, b;
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else if (h.length >= 6) { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
      else return null;
      return toHex(r, g, b);
    }
    const rm = str.match(/rgba?[\(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rm) return toHex(+rm[1], +rm[2], +rm[3]);
    return null;
  };

  const parseBg = (el) => {
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null;
    return parseColor(bg);
  };

  // 1. theme-color meta — respect media attribute for light/dark
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const media = m.getAttribute('media');
    if (media && !window.matchMedia(media).matches) continue;
    const c = parseColor(m.content);
    if (c) return c;
  }

  // 2. Safari-like approach: sample fixed/sticky elements at viewport top-center
  const els = document.elementsFromPoint(window.innerWidth / 2, 4);
  for (const el of els) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.8) continue;
    const c = parseBg(el);
    if (c) return c;
  }

  // 3. Fallback: body then html
  return parseBg(document.body) || parseBg(document.documentElement) || null;
}
`

/**
 * Parse a theme-color console signal emitted by the in-page observer.
 * Returns `null` for non-signal messages or malformed payloads (no `:` after
 * the token). The `__NULL__` sentinel maps to `color: null`.
 */
export function parseThemeSignal(message: string): { token: string; color: string | null } | null {
  if (!message.startsWith(THEME_COLOR_SIGNAL_PREFIX)) return null
  const payload = message.slice(THEME_COLOR_SIGNAL_PREFIX.length)
  const delimiterIdx = payload.indexOf(':')
  if (delimiterIdx <= 0) return null
  const token = payload.slice(0, delimiterIdx)
  const value = payload.slice(delimiterIdx + 1).trim()
  return { token, color: value === THEME_COLOR_NULL_SENTINEL ? null : value }
}

/** Parent-provided dependencies the theme extractor needs. */
export interface ThemeExtractorDeps {
  /** Whether an instance id is still tracked (guards deferred timers). */
  hasInstance(id: string): boolean
  /** Notify listeners that an instance's state changed. */
  emitStateChange(instance: BrowserInstance): void
}

export class BrowserThemeExtractor {
  constructor(private readonly deps: ThemeExtractorDeps) {}

  async extract(instance: BrowserInstance): Promise<void> {
    if (instance.themeColor) return // already set by did-change-theme-color or observer
    const urlAtStart = instance.currentUrl
    try {
      const color = await instance.pageView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`)
      // Guard: if user navigated away during extraction, discard stale result
      if (instance.currentUrl !== urlAtStart) return
      if (typeof color === 'string' && color.length > 0) {
        this.apply(instance, color)
      }
    } catch {
      // page destroyed or JS error — ignore
    }
  }

  apply(instance: BrowserInstance, color: string | null): void {
    if (instance.themeColor === color) return
    instance.themeColor = color
    if (!instance.window.isDestroyed() && !instance.toolbarView.webContents.isDestroyed()) {
      instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.THEME_COLOR, color)
    }
    this.deps.emitStateChange(instance)
  }

  installObserver(instance: BrowserInstance, allowRetry = true): void {
    // react-doctor-disable-next-line insecure-crypto-risk -- Math.random used only for a non-secret themeObserverToken correlation nonce, not auth/crypto
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const urlAtInstall = instance.currentUrl
    instance.themeObserverToken = token

    void instance.pageView.webContents.executeJavaScript(`
      (() => {
        const token = ${JSON.stringify(token)};
        const prefix = ${JSON.stringify(THEME_COLOR_SIGNAL_PREFIX)} + token + ':';
        const nullSentinel = ${JSON.stringify(THEME_COLOR_NULL_SENTINEL)};
        const extractThemeColor = ${THEME_COLOR_EXTRACTOR_FN};

        const w = window;
        const previousCleanup = w.__CRAFT_THEME_OBSERVER_CLEANUP__;
        if (typeof previousCleanup === 'function') {
          try { previousCleanup(); } catch {}
        }

        let lastColor = '__unset__';
        let rafId = 0;
        let timerId = 0;
        let lastRunAt = 0;
        const minIntervalMs = ${THEME_OBSERVER_MIN_INTERVAL_MS};

        const clearScheduled = () => {
          if (timerId) {
            clearTimeout(timerId);
            timerId = 0;
          }
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        };

        const emit = (color) => {
          const normalized = typeof color === 'string' && color.length > 0 ? color : null;
          if (normalized === lastColor) return;
          lastColor = normalized;
          console.info(prefix + (normalized ?? nullSentinel));
        };

        const run = () => {
          rafId = 0;
          lastRunAt = Date.now();
          try {
            emit(extractThemeColor());
          } catch {}
        };

        const schedule = () => {
          if (rafId || timerId) return;
          const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRunAt));
          if (waitMs > 0) {
            timerId = setTimeout(() => {
              timerId = 0;
              rafId = requestAnimationFrame(run);
            }, waitMs);
            return;
          }
          rafId = requestAnimationFrame(run);
        };

        const onScroll = () => schedule();
        const onResize = () => schedule();
        const onMutation = () => schedule();

        const headObserver = new MutationObserver(onMutation);
        if (document.head) {
          headObserver.observe(document.head, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['name', 'content', 'media'],
          });
        }

        const rootObserver = new MutationObserver(onMutation);
        if (document.documentElement) {
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }
        if (document.body) {
          rootObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }

        w.addEventListener('scroll', onScroll, { passive: true });
        w.addEventListener('resize', onResize, { passive: true });

        const mql = w.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => schedule();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);

        w.__CRAFT_THEME_OBSERVER_CLEANUP__ = () => {
          headObserver.disconnect();
          rootObserver.disconnect();
          w.removeEventListener('scroll', onScroll);
          w.removeEventListener('resize', onResize);
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSchemeChange);
          else if (typeof mql.removeListener === 'function') mql.removeListener(onSchemeChange);
          clearScheduled();
        };

        // Fast first color for initial toolbar paint and after SPA route changes
        schedule();
      })()
    `).catch(() => {
      if (!allowRetry) return
      setTimeout(() => {
        if (!this.deps.hasInstance(instance.id)) return
        if (instance.currentUrl !== urlAtInstall) return
        if (instance.themeObserverToken !== token) return
        this.installObserver(instance, false)
      }, 120)
    })
  }

  scheduleEarly(instance: BrowserInstance, urlAtSchedule: string): void {
    setTimeout(() => {
      if (!this.deps.hasInstance(instance.id)) return
      if (instance.currentUrl !== urlAtSchedule) return
      void this.extract(instance)
    }, EARLY_THEME_EXTRACTION_DELAY_MS)
  }

  /**
   * Handle a page console message that may be a theme-color signal.
   * Returns `true` when the message carried the theme prefix (so the caller can
   * early-return and skip normal console capture), matching prior behavior.
   */
  handleConsoleSignal(instance: BrowserInstance, message: string): boolean {
    const signal = parseThemeSignal(message)
    if (signal) {
      if (signal.token === instance.themeObserverToken) {
        if (signal.color === null) {
          this.apply(instance, null)
        } else if (signal.color.length > 0) {
          this.apply(instance, signal.color)
        }
      }
      return true
    }
    return message.startsWith(THEME_COLOR_SIGNAL_PREFIX)
  }
}
