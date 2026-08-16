# Tasks

Plan: `docs/plans/2026-07-24-001-feat-browser-cookie-import-plan.md` (U-IDs referenced per phase).

## 1. Foundation — reader + capability (U1, U2)

- [x] 1.1 Create `packages/shared/src/browser-cookies/types.ts` with the platform-agnostic cookie
  shape returned by the reader (`name`, `value`, `domain`, `path`, `secure`, `httpOnly`,
  `expirationDate`, `sameSite`).
  - files: `packages/shared/src/browser-cookies/types.ts`
  - verify: `test -f packages/shared/src/browser-cookies/types.ts`
- [x] 1.2 Implement `readChromeCookies(opts)` in
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
- [x] 1.3 Cover the reader in `chrome-cookie-reader.test.ts` (`bun:test`): known-key decrypt,
  domain-hash prefix stripped (assert exact value), timestamp conversion incl. `0`, domain filter
  matching both `example.com` and `.example.com`, one corrupt row among three yields
  `{cookies: 3, skipped: 1}` without throwing, Keychain failure raises a typed error, non-darwin
  raises unsupported-platform.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
- [x] 1.4 Add `userOnly?: boolean` to the browser profile record and preserve it through the ENTIRE
  persistence chain. The flag must survive a save/load round-trip — a profile record that carries
  `userOnly` in memory but loses it on persist would make the security boundary fail while
  appearing to work. Four places drop unknown fields today and all must be updated:
  (a) the `BrowserProfile` interface and the `BrowserProfileInput` type in `config/types.ts`;
  (b) the explicit return type AND body of `sanitizeBrowserProfileInput`;
  (c) the `normalized` object built from scratch in `normalizeBrowserProfile`;
  (d) `normalizeBrowserProfileSettings`, which maps profiles through the normalizer.
  - files: `packages/shared/src/config/types.ts`, `packages/shared/src/config/browser-profiles.ts`, `apps/electron/src/main/browser-profile-resolver.ts`
  - verify: `grep -q "userOnly" packages/shared/src/config/types.ts && grep -q "userOnly" packages/shared/src/config/browser-profiles.ts`
- [x] 1.4b Prove the round-trip in `packages/shared/src/config/__tests__/browser-profiles.test.ts`:
  a profile with `userOnly: true` survives `sanitizeBrowserProfileInput` → `normalizeBrowserProfile`
  → `normalizeBrowserProfileSettings` with the flag intact; a profile without the flag stays
  undefined (not coerced to `false`); a non-boolean `userOnly` input is rejected/normalized rather
  than persisted as-is. This test is the guard against the silent-drop failure mode.
  - files: `packages/shared/src/config/__tests__/browser-profiles.test.ts`
  - verify: `bun test packages/shared/src/config/__tests__/browser-profiles.test.ts`
- [x] 1.5 Enforce the capability at resolution time in `browser-pane-manager.ts`: an agent-owned
  instance request that resolves to a `userOnly` profile is REFUSED with a typed error. Do not fall
  back to the default profile — a silent fallback makes an agent tool appear to succeed against the
  wrong cookie jar. Reuse the existing `ownerType` threading rather than inventing a parallel
  caller-intent concept. Implement the refusal test-first.
  - files: `apps/electron/src/main/browser-pane-manager.ts`
  - verify: `grep -q "userOnly" apps/electron/src/main/browser-pane-manager.ts`
- [x] 1.6 Cover the capability in
  `apps/electron/src/main/__tests__/browser-profile-capability.test.ts`: agent request naming a
  user-only profile is refused and creates no instance; agent request with no profileId still
  resolves to default (no regression); user-owned request to a user-only profile succeeds;
  `getProfilePartition` for a user-only profile never returns `persist:browser-pane`.
  - files: `apps/electron/src/main/__tests__/browser-profile-capability.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-profile-capability.test.ts`
- [x] 1.7 Run gates: focused tests for the three touched areas plus
  `openspec validate add-browser-cookie-import --strict --no-interactive`.
  **Baseline note (verified 2026-07-24):** `bun run typecheck:all` is RED on `main` before this
  change, in `packages/session-tools-core/src/tool-defs.ts:637` and `scripts/build/common.ts`
  (build script + a pre-existing `unknown`→`ToolResult` assignment). Neither file is touched by this
  change, and typecheck reports zero errors in every file this change does touch. The gate for this
  phase is therefore "no NEW typecheck errors in touched files", not a globally green
  `typecheck:all`. Fixing the pre-existing baseline is out of scope here.
  - verify: `openspec validate add-browser-cookie-import --strict --no-interactive`
- [x] 1.8 CARRY-FORWARD to phase 2/3 (found during phase 1 audit): `resolveBrowserProfileId` returns
  early for `DEFAULT_BROWSER_PROFILE_ID` **before** the `userOnly` check, so marking the DEFAULT
  profile user-only would not be enforced (fails open). The intended flow creates a separate
  profile, so this is not a phase-1 blocker — but the UI must refuse to mark the default profile
  user-only, or the resolver must check it. Decide and close in phase 3.
  - files: `apps/electron/src/main/browser-profile-resolver.ts`
  - verify: `grep -q "DEFAULT_BROWSER_PROFILE_ID" apps/electron/src/main/browser-profile-resolver.ts`
- [x] 1.9 CARRY-FORWARD: the production SQLite path (`better-sqlite3`) is unexercised by tests — Bun
  1.3.14 cannot load its native binding, so tests inject `bun:sqlite` through the database seam.
  **Closed by 3.15**, not by 4.1: the path is now exercised end to end in a Node child process
  (the Electron runtime) against a real SQLite file in Chrome's cookie schema, with no database
  seam injected. 4.1 remains as the with-real-Chrome check.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.node-harness.ts`, `packages/shared/src/browser-cookies/chrome-cookie-reader.production-path.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/chrome-cookie-reader.production-path.test.ts`

## 2. Injection (U3)

- [x] 2.1 Add `BrowserPaneManager.importCookies(profileId)`: refuse a target that is not a known,
  user-only profile with a typed `UserOnlyBrowserProfileRequiredError` before any read or write,
  resolve the partition via `getProfilePartition(profileId)`, obtain the session with
  `session.fromPartition(...)` (idempotent — same Session the pane uses), and write each cookie with
  `cookies.set(...)`. Build `url` as `http${secure?'s':''}://${host_key without leading dot}${path}`,
  preserve the leading dot in `domain` for domain cookies, and map Chrome's integer `samesite`
  (`-1|0|1|2`) to Electron's `unspecified|no_restriction|lax|strict`. Return `{imported, skipped}`
  counts only — never cookie values.
  - files: `apps/electron/src/main/browser-pane-manager.ts`
  - verify: `grep -q "cookies.set" apps/electron/src/main/browser-pane-manager.ts`
- [x] 2.2 Cover injection in
  `apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`: three cookies map to three
  `cookies.set` calls with asserted `url`/`sameSite`/dotted-domain mapping; secure→`https`,
  non-secure→`http`; all four `samesite` values map correctly; one rejection among three still
  imports the others and reports `skipped: 1`; an unknown profile and a non-user-only profile each
  make ZERO `cookies.set` calls and reject with `UserOnlyBrowserProfileRequiredError`; the returned
  object serializes with no cookie values.
  - files: `apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
- [x] 2.3 Run gates: `bun run typecheck:all` and the two new test files.
  - verify: `bun run typecheck:all`

- [ ] 2.4 CARRY-FORWARD (found during phase 2 audit, orchestrator-verified): running the whole
  `apps/electron/src/main/__tests__/` directory reports `SyntaxError: Missing 'default' export in
  module main/logger.ts`. Measured: the pristine baseline (`adff3c1a`, zero feature code) already
  produces 1 such error over 21 files; with this change's 2 new test files it is 3 over 23. The new
  tests DO mock `../logger` with a `default` key, matching the existing
  `browser-pane-manager.test.ts` pattern — the failure comes from Bun's global `mock.module`
  registry depending on cross-file load order, and `logger.ts` exporting no `default`. Each new file
  passes cleanly in isolation (12/12). This is a pre-existing test-harness fragility that scales
  with file count, not a defect introduced here; fixing it means changing the repo's logger
  mocking strategy, which is out of scope for this change. Raise separately if CI noise matters.
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts apps/electron/src/main/__tests__/browser-profile-capability.test.ts`
- [ ] 2.5 CARRY-FORWARD: `apps/electron/src/main/__tests__/browser-pane-manager.test.ts` >
  "runs early theme extraction shortly after navigation" fails. Verified pre-existing: it fails
  identically at `adff3c1a` (pristine baseline, before any feature code). Timing-sensitive
  (`Bun.sleep(140)`), unrelated to cookies. Not ours to fix in this change.

## 3. Surfaces — bulk UI (U4)

- [x] 3.1 Wire the RPC channel following the existing `browserPane.createProfile` recipe: add
  `IMPORT_COOKIES` to `channels.ts`, add the `browserPane.importCookies` leaf to `RPC_CONTRACT` in
  `shared/types.ts` (which derives both `ElectronAPI` and `CHANNEL_MAP` — no manual `channel-map.ts`
  edit), and register the handler with `server.handle` in `handlers/browser.ts`.
  - files: `packages/shared/src/protocol/channels.ts`, `apps/electron/src/shared/types.ts`, `apps/electron/src/main/handlers/browser.ts`
  - verify: `grep -q "IMPORT_COOKIES" packages/shared/src/protocol/channels.ts && grep -q "importCookies" apps/electron/src/shared/types.ts`
- [x] 3.2 Add the "Import from Chrome" action to
  `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx` beside the existing
  create/delete actions (no new settings subpage). Show a confirmation naming which Chrome profile
  is read, which app profile receives the cookies, that a macOS Keychain prompt will appear, and
  that the agent cannot drive a user-only profile. Report `imported`/`skipped` counts; never show
  cookie names or values. Add `en.json` + `pt-BR.json` strings.
  - files: `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`, `packages/shared/src/i18n/locales/en.json`, `packages/shared/src/i18n/locales/pt-BR.json`
  - verify: `grep -q "importCookies" apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`

### Cancelled — the agent-facing `import_cookies` tool (owner decision, 2026-08-10)

Tasks 3.3–3.7 are **out of scope and will not be implemented**. The owner settled the product
question: this feature is user-only. The `userOnly` capability exists precisely so an
agent-driven pane can never resolve the partition holding the user's imported cookie jar; an
agent-callable `import_cookies` would hand the agent that jar through the front door and
dismantle the property the rest of this change is built around. The corresponding capability has
been removed from the spec delta so the spec does not assert behavior the code will never have.

- [ ] ~~3.3 Register the `import_cookies` tool in `packages/session-tools-core/src/tool-defs.ts`.~~
  **Out of scope:** no agent-facing cookie tool.
- [ ] ~~3.4 Add `importCookies(domain)` to `BrowserPaneFns` and `SessionManager`.~~
  **Out of scope:** serves only the cancelled tool.
- [ ] ~~3.5 Implement the agent-tool domain denylist in `SessionManager`.~~
  **Out of scope as specified** (it guarded the cancelled tool). The denylist itself survives and
  moved into the reader, where it protects the user path too — see 3.9.
- [ ] ~~3.6 Implement ephemerality for agent-imported cookies.~~
  **Out of scope:** there are no agent-imported cookies.
- [ ] ~~3.7 Cover the tool in `tool-defs.test.ts`.~~
  **Out of scope:** serves only the cancelled tool.

### Hardening carried into this change

- [x] 3.9 Classify `browserPane.IMPORT_COOKIES` (and the new
  `browserPane.PREVIEW_COOKIE_IMPORT`) in `LOCAL_ONLY_NAMESPACES`. An unclassified channel makes
  `isLocalOnly()` return `false`, so `RoutedClient` proxies it to the workspace client — against a
  remote host the reader would open the SERVER's Keychain and cookie store.
  - files: `packages/shared/src/protocol/routing.ts`, `packages/shared/src/protocol/__tests__/routing.test.ts`
  - verify: `bun test packages/shared/src/protocol/__tests__/routing.test.ts`
- [x] 3.10 Apply the sensitive-host denylist in the reader, **before** decryption, defaulting to
  `accounts.google.com`, `google.com`, `mail.google.com` and overridable per call. A withheld row
  is reported as `blocked`, distinct from a row that failed to decrypt.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `packages/shared/src/browser-cookies/types.ts`
  - verify: `bun test packages/shared/src/browser-cookies/`
- [x] 3.11 Replace the blind confirmation with counts: add `previewChromeCookies` (reads `host_key`
  only — no decryption, no Keychain prompt), expose it as `browserPane.previewCookieImport`, and
  have the picker state cookies, distinct hosts and withheld counts before the user confirms.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `apps/electron/src/main/browser-pane-manager.ts`, `apps/electron/src/main/handlers/browser.ts`, `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`, `apps/electron/src/renderer/hooks/useBrowserProfiles.ts`
  - verify: `bun test apps/electron/src/main/__tests__/browser-pane-cookie-import.test.ts`
- [x] 3.12 Wipe the derived AES key (`key.fill(0)`) once a read finishes, and sweep stranded
  `craft-chrome-cookies-*` temp copies at main-process startup (an exit hook cannot run after
  SIGKILL, which is the case that strands the copy).
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `apps/electron/src/main/index.ts`
  - verify: `bun test packages/shared/src/browser-cookies/chrome-cookie-reader.production-path.test.ts`
- [x] 3.13 Validate the Chrome profile name against `/^[A-Za-z0-9 _-]+$/` and confine the resolved
  database path under the browser's application-support directory; map each
  `ChromeCookieReaderError` code to its own i18n message instead of one opaque string, logging only
  the code.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `apps/electron/src/main/handlers/browser.ts`, `packages/shared/src/i18n/locales/*.json`
  - verify: `bun test apps/electron/src/main/handlers/__tests__/browser-cookie-import.test.ts`
- [x] 3.14 Replace `timingSafeEqual` with `.equals()` for the domain-hash prefix check. Both sides
  are derived locally from the row's own host; there is no secret and no attacker measuring time,
  so the constant-time call falsely signalled one.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`
  - verify: `grep -q "timingSafeEqual" packages/shared/src/browser-cookies/chrome-cookie-reader.ts; test $? -ne 0`
- [x] 3.15 Closes 1.9: exercise the production `better-sqlite3` path end to end against a real
  SQLite file in Chrome's cookie schema, in a Node child process (Bun cannot instantiate
  `better-sqlite3`). Covers decryption, domain-hash stripping, the denylist, `skipped` counting,
  the key wipe and the temp sweep.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.node-harness.ts`, `packages/shared/src/browser-cookies/chrome-cookie-reader.production-path.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/chrome-cookie-reader.production-path.test.ts`
- [x] 3.16 Run gates: `bun run typecheck:all`, `bun run lint`, `bun run lint:i18n:parity`, the
  focused tests above, and `openspec validate add-browser-cookie-import --strict
  --no-interactive`. `lint:tool-contracts` is not applicable — no session tool changed.
  - verify: `openspec validate add-browser-cookie-import --strict --no-interactive`
- [x] 3.17 Close the denylist coverage hole: matching is exact per host, so name every host that
  carries the same Google account session (`www.google.com`, `docs.google.com`, `drive.google.com`,
  `myaccount.google.com`, `googleapis.com`, `youtube.com`, `www.youtube.com`) in
  `DEFAULT_SENSITIVE_HOST_DENYLIST`. The master cookies (`SID`, `SAPISID`, `__Secure-3PSID`) ride on
  `.youtube.com` too, so withholding only the account/mail hosts let an equivalent session through
  while the confirmation claimed the account was protected. Do NOT switch to a registrable-suffix
  rule — that changes the semantics the spec declares. Cover it with a test that asserts the value
  is never decrypted (row encrypted under a foreign password lands in `blocked`, not `skipped`).
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/`
- [x] 3.18 Stop an empty override from disabling the denylist: `denylist ?? DEFAULT` does not catch
  `[]`, so the idiomatic `denylist: config.denylist ?? []` of a future consumer of the public
  `ChromeCookieScanOptions` would silently withhold nothing. Use `denylist?.length ? denylist :
  DEFAULT_SENSITIVE_HOST_DENYLIST` and say so in the jsdoc of the public field.
  - files: `packages/shared/src/browser-cookies/chrome-cookie-reader.ts`, `packages/shared/src/browser-cookies/chrome-cookie-reader.test.ts`
  - verify: `bun test packages/shared/src/browser-cookies/`
- [x] 3.19 Replace `reason in COOKIE_IMPORT_FAILURE_REASONS` with
  `Object.hasOwn(COOKIE_IMPORT_FAILURE_REASONS, reason)` in `BrowserProfilePicker`: `in` walks the
  prototype chain, so `constructor`/`toString`/`valueOf` passed the guard and produced a
  nonexistent i18n key that i18next renders as the key itself. Narrow `indexOf` to `startsWith` —
  the transport preserves the message verbatim, so the prefix is at position 0.
  - files: `apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`
  - verify: `grep -q "Object.hasOwn(COOKIE_IMPORT_FAILURE_REASONS" apps/electron/src/renderer/components/browser/BrowserProfilePicker.tsx`
- [x] 3.20 Correct the spec delta: state the real denylist coverage and the empty-override fallback,
  and qualify the path-confinement requirement so it does not claim a control the code does not
  exercise — `cookieDbPath` is a test seam that replaces location entirely and is unreachable from
  the user/agent surfaces (both RPCs take only `profileId`).
  - files: `openspec/changes/add-browser-cookie-import/specs/browser-cookie-import/spec.md`
  - verify: `bunx openspec validate add-browser-cookie-import --strict --no-interactive`

## 4. Validation (orchestrator-owned — not worker-closeable)

- [ ] 4.1 Real validation: launch the app, create a user-only profile, click "Import from Chrome",
  and SEE a previously logged-in site render authenticated in the embedded browser. Screenshot.
- [ ] 4.2 Real validation: confirm the agent cannot drive the user-only profile (attempt an
  agent-driven browser call against it and observe the refusal).
- [ ] ~~4.3 Real validation: exercise `import_cookies` on a benign non-denylisted domain.~~
  **Out of scope:** the agent tool was cancelled (see above).
- [ ] 4.4 Run `vibe-security` before any push (mandatory for every push, and this is a credential
  path).
