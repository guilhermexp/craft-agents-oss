# Tasks

Plan: `docs/plans/2026-07-24-001-feat-browser-cookie-import-plan.md` (U-IDs referenced per phase).

## 1. Foundation — reader + capability (U1, U2)

- [ ] 1.1 Create `packages/shared/src/browser-cookies/types.ts` with the platform-agnostic cookie
  shape returned by the reader (`name`, `value`, `domain`, `path`, `secure`, `httpOnly`,
  `expirationDate`, `sameSite`).
  - files: `packages/shared/src/browser-cookies/types.ts`
  - verify: `test -f packages/shared/src/browser-cookies/types.ts`
- [ ] 1.2 Implement `readChromeCookies(opts)` in
  `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`: locate the Chrome/Chromium profile
  cookie DB, copy it to a temp path before opening (the live DB is locked), query with
  `better-sqlite3`, read the Keychain `Chrome Safe Storage` password, derive with
  `pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1')`, decrypt `v10`-prefixed values with `aes-128-cbc`
  and a 16-byte `0x20` IV. Strip the 32-byte domain-hash prefix present in recent Chrome builds.
  Convert `expires_utc` (microseconds since 1601-01-01) with `/1e6 - 11644473600`; treat `0` as a
  session cookie. Inject the Keychain read and DB path as constructor/param seams so tests never
  touch the real Keychain. Per-row decryption failures increment `skipped` and never throw.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`
  - verify: `grep -q "pbkdf2" packages/shared/src/browser-cookies/chrome-cookie-reader.ts && grep -q "11644473600" packages/shared/src/browser-cookies/chrome-cookie-reader.ts`
- [ ] 1.3 Cover the reader in `chrome-cookie-reader.test.ts` (`bun:test`): known-key decrypt,
  domain-hash prefix stripped (assert exact value), timestamp conversion incl. `0`, domain filter
  matching both `example.com` and `.example.com`, one corrupt row among three yields
  `{cookies: 3, skipped: 1}` without throwing, Keychain failure raises a typed error, non-darwin
  raises unsupported-platform.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
- [ ] 1.4 Add `userOnly?: boolean` to the browser profile record and thread it through
  `browser-profile-resolver.ts` / profile settings persistence.
  - files: `apps/electron/src/main/browser-profile-resolver.ts`
  - verify: `grep -q "userOnly" apps/electron/src/main/browser-profile-resolver.ts`
- [ ] 1.5 Enforce the capability at resolution time in `browser-pane-manager.ts`: an agent-owned
  instance request that resolves to a `userOnly` profile is REFUSED with a typed error. Do not fall
  back to the default profile — a silent fallback makes an agent tool appear to succeed against the
  wrong cookie jar. Reuse the existing `ownerType` threading rather than inventing a parallel
  caller-intent concept. Implement the refusal test-first.
  - files: `apps/electron/src/main/browser-pane-manager.ts`
  - verify: `grep -q "userOnly" apps/electron/src/main/browser-pane-manager.ts`
- [ ] 1.6 Cover the capability in
  `apps/electron/src/main/__tests__/browser-profile-capability.test.ts`: agent request naming a
  user-only profile is refused and creates no instance; agent request with no profileId still
  resolves to default (no regression); user-owned request to a user-only profile succeeds;
  `getProfilePartition` for a user-only profile never returns `persist:browser-pane`.
  - files: `apps/electron/src/main/__tests__/browser-profile-capability.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-profile-capability.test.ts`
- [ ] 1.7 Run gates: `bun run typecheck:all`, `bun test packages/shared/src/browser-cookies/`, and
  `openspec validate add-browser-cookie-import --strict --no-interactive`.
  - verify: `openspec validate add-browser-cookie-import --strict --no-interactive`

## 2. Injection (U3)

- [ ] 2.1 Add `BrowserPaneManager.importCookies({ profileId, domain, callerIntent })`: resolve the
  partition via `getProfilePartition(resolveProfileId(profileId))`, obtain the session with
  `session.fromPartition(...)` (idempotent — same Session the pane uses), and write each cookie with
  `cookies.set(...)`. Build `url` as `http${secure?'s':''}://${host_key without leading dot}${path}`,
  preserve the leading dot in `domain` for domain cookies, and map Chrome's integer `samesite`
  (`-1|0|1|2`) to Electron's `unspecified|no_restriction|lax|strict`. Return `{imported, skipped}`
  counts only — never cookie values. Refuse agent-intent calls against a `userOnly` profile before
  any write.
  - files: `apps/electron/src/main/browser-pane-manager.ts`
  - verify: `grep -q "cookies.set" apps/electron/src/main/browser-pane-manager.ts`
- [ ] 2.2 Cover injection in
  `apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`: three cookies map to three
  `cookies.set` calls with asserted `url`/`sameSite`/dotted-domain mapping; secure→`https`,
  non-secure→`http`; all four `samesite` values map correctly; one rejection among three still
  imports the others and reports `skipped: 1`; an agent-intent call against a user-only profile
  makes ZERO `cookies.set` calls; the returned object serializes with no cookie values.
  - files: `apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
- [ ] 2.3 Run gates: `bun run typecheck:all` and the two new test files.
  - verify: `bun run typecheck:all`

## 3. Surfaces — bulk UI + agent tool (U4, U5)

- [ ] 3.1 Wire the RPC channel following the existing `browserPane.createProfile` recipe: add
  `IMPORT_COOKIES` to `channels.ts`, register in `HANDLED_CHANNELS` + `server.handle` in
  `handlers/browser.ts`, map in `channel-map.ts`, and add the signature to `shared/types.ts`.
  - files: `packages/shared/src/protocol/channels.ts`, `apps/electron/src/main/handlers/browser.ts`, `apps/electron/src/transport/channel-map.ts`, `apps/electron/src/shared/types.ts`
  - verify: `grep -q "IMPORT_COOKIES" packages/shared/src/protocol/channels.ts && grep -q "importCookies" apps/electron/src/transport/channel-map.ts`
- [ ] 3.2 Add the "Import from Chrome" action to
  `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx` beside the existing
  create/delete actions (no new settings subpage). Show a confirmation naming which Chrome profile
  is read, which app profile receives the cookies, that a macOS Keychain prompt will appear, and
  that the agent cannot drive a user-only profile. Report `imported`/`skipped` counts; never show
  cookie names or values. Add `en.json` + `pt-BR.json` strings.
  - files: `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`, `packages/shared/src/i18n/locales/en.json`, `packages/shared/src/i18n/locales/pt-BR.json`
  - verify: `grep -q "importCookies" apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`
- [ ] 3.3 Register the `import_cookies` tool in `packages/session-tools-core/src/tool-defs.ts`:
  `ImportCookiesSchema = z.object({ domain: z.string().min(1) })`, a `TOOL_DESCRIPTIONS` entry, and
  a `defineTool('import_cookies', { executionMode: 'backend', safeMode: 'block', handler: null })`
  entry in `SESSION_TOOL_DEFS`.
  - files: `packages/session-tools-core/src/tool-defs.ts`
  - verify: `grep -q "import_cookies" packages/session-tools-core/src/tool-defs.ts`
- [ ] 3.4 Add `importCookies(domain)` to the `BrowserPaneFns` interface in
  `packages/shared/src/agent/browser-tools.ts` and implement it in the `browserPaneFns` object in
  `packages/server-core/src/sessions/SessionManager.ts`, resolving the session's OWN instance —
  the signature must accept no profileId, so the model cannot target another profile.
  - files: `packages/shared/src/agent/browser-tools.ts`, `packages/server-core/src/sessions/SessionManager.ts`
  - verify: `grep -q "importCookies" packages/shared/src/agent/browser-tools.ts && grep -q "importCookies" packages/server-core/src/sessions/SessionManager.ts`
- [ ] 3.5 Implement the denylist and refuse BEFORE the reader runs: Google account hosts
  (`accounts.google.com`, `google.com`, `mail.google.com`) plus a configurable high-sensitivity
  list. The refusal message names the reason and points at the user-only profile. Google is also
  where DBSC actually bites — those cookies are device-bound and would not authenticate even if
  copied, so refusing is honest rather than restrictive.
  - files: `packages/server-core/src/sessions/SessionManager.ts`
  - verify: `grep -q "accounts.google.com" packages/server-core/src/sessions/SessionManager.ts`
- [ ] 3.6 Implement ephemerality: record imported `(domain, cookie names)` on the session and clear
  them from the partition on session end / instance destroy via the existing teardown path. Also
  clear tracked agent-imported cookies on startup so a crashed session does not leak them forward.
  - files: `packages/server-core/src/sessions/SessionManager.ts`
  - verify: `grep -q "cookies.remove" packages/server-core/src/sessions/SessionManager.ts`
- [ ] 3.7 Cover the tool: denylisted domain refused with ZERO reader calls; tool registered with
  `safeMode: 'block'` and `executionMode: 'backend'`; schema rejects empty/non-string domain; tool
  result contains no cookie values; teardown removes exactly what was imported.
  - files: `packages/session-tools-core/src/tool-defs.test.ts`
  - verify: `bun test packages/session-tools-core/src/tool-defs.test.ts`
- [ ] 3.8 Run gates: `bun run typecheck:all`, `bun run lint:tool-contracts` (session-tool contract
  changed), full `bun test`, and `openspec validate add-browser-cookie-import --strict
  --no-interactive`.
  - verify: `bun run lint:tool-contracts`

## 4. Validation (orchestrator-owned — not worker-closeable)

- [ ] 4.1 Real validation: launch the app, create a user-only profile, click "Import from Chrome",
  and SEE a previously logged-in site render authenticated in the embedded browser. Screenshot.
- [ ] 4.2 Real validation: confirm the agent cannot drive the user-only profile (attempt an
  agent-driven browser call against it and observe the refusal).
- [ ] 4.3 Real validation: exercise `import_cookies` on a benign non-denylisted domain, confirm the
  pane is authenticated, then confirm cleanup removed the cookies after session end.
- [ ] 4.4 Run `vibe-security` before any push (mandatory for every push, and this is a credential
  path).
