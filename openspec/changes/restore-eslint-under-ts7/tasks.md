# Tasks

## 1. Isolate the linter's TypeScript (Item 1)

- [x] 1.1 Add `typescript-for-eslint: "npm:typescript@5.9.3"` to root `devDependencies`, keeping
  `typescript: ^7.0.2` untouched so `tsc` stays the native port.
  - files: `package.json`
  - verify: `node -e "console.log(require('./node_modules/typescript-for-eslint/package.json').version)"`
- [x] 1.2 Add `scripts/link-eslint-typescript.mjs`: walk the dependency closure of `eslint`,
  `eslint-plugin-*`, `eslint-config-*` and `@typescript-eslint/*`; for every package declaring
  `typescript` in deps/peerDeps/optionalDeps, materialize `<pkg>/node_modules/typescript` as a link
  to the alias (junction on Windows). Idempotent, fails loudly when the alias is missing, never
  clobbers a real nested install.
  - files: `scripts/link-eslint-typescript.mjs`
  - verify: `bun run scripts/link-eslint-typescript.mjs`
- [x] 1.3 Bind it to the install lifecycle via root `postinstall`.
  - files: `package.json`
  - verify: `bun install` prints the linker line
- [x] 1.4 Prove reproducibility: `rm -rf node_modules && bun install && bun run lint`.
  - verify: lint reports per-file results and exits 0

## 2. Re-enable the gate (Item 2)

- [x] 2.1 Point `apps/electron` `build` at `lint`; delete the `lint:check` wrapper and the
  `//lint:check` debt comment.
  - files: `apps/electron/package.json`
  - verify: `grep -c 'lint:check' apps/electron/package.json` is 0
- [x] 2.2 Run the repo lint target in CI `validate:ci`; record the pre-commit hook decision.
  - files: `package.json`, `.github/workflows/validate.yml`
  - verify: `bun run lint`

## 3. Clear the errors (Item 3)

- [x] 3.1 `craft-shared/no-inline-source-auth-check` (4, `packages/shared`) — replace inline
  `source.config.isAuthenticated` reads with `isSourceUsable()`.
  - files: `packages/shared/src/craft-bridge/context.ts`,
    `packages/shared/src/resources/__tests__/resource-bundle.test.ts`,
    `packages/shared/src/sources/__tests__/token-refresh-manager.test.ts`
  - verify: `cd packages/shared && npx eslint .`
- [x] 3.2 `craft-links/no-direct-file-open` (2) — route through `onOpenFile`.
  - files: `apps/electron/src/renderer/components/app-shell/SessionInfoPopover.tsx`,
    `apps/electron/src/renderer/pages/ProjectInfoPage.tsx`
  - verify: `cd apps/electron && npx eslint src/`
- [x] 3.3 `craft-styles/no-hardcoded-z-index` (1) — use the z-index token.
  - files: `apps/electron/src/renderer/components/perf/PerfOverlay.tsx`
  - verify: `cd apps/electron && npx eslint src/renderer/components/perf/PerfOverlay.tsx`
- [x] 3.4 `jsx-a11y/no-static-element-interactions` (2, "rule not found") — remove the dead disable
  directives; the plugin is not and will not be loaded.
  - files: `apps/electron/src/renderer/components/automations/AutomationEventTimeline.tsx`,
    `packages/ui/src/components/ui/FilterableSelectPopover.tsx`
  - verify: `cd packages/ui && npx eslint .`
- [x] 3.5 `craft-styles/no-nonstandard-shadows` (13) — approved token where an equivalent is
  obvious; otherwise a documented waiver in the existing exception block. No invented shadows.
  - files: `apps/electron/eslint.config.mjs`, `packages/ui/eslint.config.mjs`, affected components
  - verify: `bun run lint`
- [x] 3.6 `ruleId: null` (16) — all 16 are `eslint-disable` directives naming rules no flat config
  enables (`@typescript-eslint/no-explicit-any`, `no-control-regex`, `no-constant-condition`,
  `@typescript-eslint/no-var-requires`) or hook deps that are now exhaustive. Removed with
  `eslint --fix --fix-type directive`, then the whitespace-only remnant lines deleted. The
  explanatory prose that sat on its own line above each directive is preserved.
  - verify: `bun run lint`
- [x] 3.7 Fix the `no-nonstandard-shadows` false positive on shadow *resets*: `''` is the only way
  to drop an inline shadow and cannot introduce a nonstandard one, so `allowInlineNone` now
  accepts it alongside `'none'`. Applied to both copies of the rule, covered by a new test.
  - files: `packages/ui/eslint-rules/no-nonstandard-shadows.cjs`,
    `apps/electron/eslint-rules/no-nonstandard-shadows.cjs`,
    `packages/ui/eslint-rules/__tests__/no-nonstandard-shadows.test.ts`
  - verify: `bun test packages/ui/eslint-rules/__tests__/no-nonstandard-shadows.test.ts`
- [x] 3.8 Migrate `apps/electron/eslint-rules/__tests__/no-hardcoded-z-index.test.ts` off the
  eslintrc `Linter` mode ESLint 10 removed (the `packages/ui` twin was already migrated). It was
  failing on `main`; the AGENTS.md validation snippet now points at this suite.
  - verify: `bun test apps/electron/eslint-rules/__tests__/`

## 4. Documentation and gates

- [x] 4.1 Document the isolation in `docs/eslint-typescript7.md` and reference it from the AGENTS.md
  chain.
  - files: `docs/eslint-typescript7.md`, `AGENTS.md`
  - verify: `test -f docs/eslint-typescript7.md`
- [x] 4.2 `bunx openspec validate restore-eslint-under-ts7 --strict --no-interactive`
- [x] 4.3 `bun run typecheck:all`
- [x] 4.4 `bun test` once, compared by test name against the pre-change baseline.
