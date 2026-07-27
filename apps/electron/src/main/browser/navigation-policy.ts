/**
 * Navigation policy for the agentic browser.
 *
 * SECURITY (auditoria 2026-07-14 / F7-R1): top-level navigation and popups are
 * restricted to http/https (+ about:blank). Blocks `file:`, `chrome:`, etc. that
 * a prompt-injected agent could use to read local files (~/.aws/credentials,
 * .env, id_rsa) or perform SSRF. This is the pure decision layer, unit-testable
 * without an Electron window — `BrowserPaneManager` wires it into the
 * `will-navigate` / `setWindowOpenHandler` events and performs the side effects.
 *
 * TODO(security): consider blocking loopback/link-local (169.254.169.254,
 * localhost) — no legitimate agent use case today.
 */

import type { BrowserNavigationPolicy } from '../browser-pane-manager'

/** Craft deep-link scheme prefix, e.g. `craftagents://`. */
export const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`

/** True when `url` targets the Craft deep-link scheme rather than the web. */
export function isDeepLinkUrl(url: string): boolean {
  return url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)
}

/** True when `rawUrl` is a permitted top-level target (http/https, or about:blank). */
export function isAllowedTopLevelUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return true
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** What the pane manager should do with a navigation or popup request. */
export type NavigationOutcome =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'external' }
  | { action: 'deep-link' }

/**
 * Decide a page-initiated top-level navigation (`will-navigate`).
 * Order: custom policy → deep link → scheme allowlist.
 */
export function decideWillNavigate(url: string, policy?: BrowserNavigationPolicy): NavigationOutcome {
  const decision = policy?.willNavigate?.(url)
  if (decision?.action === 'deny') return { action: 'deny', reason: decision.reason ?? 'policy' }
  if (decision?.action === 'external') return { action: 'external' }
  if (isDeepLinkUrl(url)) return { action: 'deep-link' }
  if (!isAllowedTopLevelUrl(url)) return { action: 'deny', reason: 'unsupported_scheme' }
  return { action: 'allow' }
}

/**
 * Decide a `window.open` / popup request. Order: deep link → custom policy →
 * scheme allowlist. Deep links are intercepted before the policy so the app
 * can route them regardless of a workspace policy's opinion.
 */
export function decideWindowOpen(url: string, policy?: BrowserNavigationPolicy): NavigationOutcome {
  if (isDeepLinkUrl(url)) return { action: 'deep-link' }
  const decision = policy?.windowOpen?.(url)
  if (decision?.action === 'deny') return { action: 'deny', reason: decision.reason ?? 'policy' }
  if (decision?.action === 'external') return { action: 'external' }
  if (!isAllowedTopLevelUrl(url)) return { action: 'deny', reason: 'unsupported_scheme' }
  return { action: 'allow' }
}
