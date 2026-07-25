# Add Browser Cookie Import

## Why

The embedded browser starts every session logged out, while the same machine's Chrome holds valid
sessions for the sites the user cares about. Manual re-login inside the app is friction for the
user and a hard stop for the agent (CAPTCHA/MFA cannot be automated).

Importing cookies naively is unsafe here. `persist:browser-pane` is agent-driven: `browser_tool`
exposes `navigate` and `evaluate` (`packages/shared/src/agent/browser-tool-runtime.ts`), and a
2026-07-14 audit traced an exfiltration chain on this exact surface (PR #3 closed the `file://`
scheme hole; the agent-drives-the-page property remains by design). Loading a user's full cookie
jar into that partition would let a single injected page turn prompt injection into full web
identity theft — `httpOnly` does not save it, since an authenticated navigate plus DOM scrape works
regardless, and many auth cookies are not `httpOnly`.

This change therefore introduces the missing security boundary first — a browser profile the agent
can never resolve to — and only then the two import surfaces.

## What Changes

- Add a `chrome-cookie-reader` module that reads and decrypts cookies from the local
  Chrome/Chromium cookie store on macOS (Keychain `Chrome Safe Storage` → PBKDF2-SHA1 →
  AES-128-CBC), filterable by domain, with no Electron dependency so it is unit-testable.
- Add a **user-only** capability to browser profiles, enforced at profile resolution: an
  agent-driven browser request can never obtain a session for a user-only profile, and is refused
  rather than silently falling back to the default profile.
- Add `BrowserPaneManager.importCookies(...)` which writes decrypted cookies into the resolved
  partition's Chromium cookie store, honoring the user-only capability check.
- Add an "Import from Chrome" action in the browser profile picker that bulk-populates a user-only
  profile, with a confirmation naming what is read and which profile receives it.
- Add a discrete `import_cookies(domain)` session tool (`executionMode: 'backend'`,
  `safeMode: 'block'`) that imports a single domain into the agent's own session profile,
  ephemerally, refusing denylisted and device-bound (DBSC) domains.

## Non-Goals

- Do not port `mvanhorn/agentcookie`. It solves cross-machine sync (Go daemon, Tailscale,
  source/sink LaunchAgents); only its domain-policy and DBSC-detection ideas are reimplemented
  natively.
- Do not support Windows (DPAPI / App-Bound Encryption v20), Linux (libsecret), Safari (Full Disk
  Access + `binarycookies`), or Firefox in this change. The reader interface stays
  platform-agnostic so backends can be added later.
- Do not route cookies through `CredentialManager` / `SecureStorageBackend`; imported cookies live
  in the Chromium partition store only. Adding raw session material to that backend would inherit
  the key-derivation weakness `harden-credential-storage` is actively addressing.
- Do not implement continuous sync or watch Chrome's cookie DB for changes; import is a
  point-in-time action.
- Do not implement just-in-time import on navigation. It depends on this plumbing and adds a
  request-interception surface that needs its own review.
- Do not let the model name a target profile for `import_cookies`; the agent tool always resolves
  the session's own profile.
- Do not log, persist to app JSON, or return decrypted cookie values in any tool result or UI.
- Do not modify or commit the unrelated dirty renderer/i18n/config files already present in the
  working tree.
