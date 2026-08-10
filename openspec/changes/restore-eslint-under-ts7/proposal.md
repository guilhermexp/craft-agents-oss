# Restore ESLint under TypeScript 7

## Why

`bun run lint` is dead across the whole repo. All three targets (`apps/electron`,
`packages/shared`, `packages/ui`) crash before reading a single source file:

```
Oops! Something went wrong! :(
ESLint: 10.7.0
TypeError: Cannot read properties of undefined (reading 'Cjs')
    at node_modules/@typescript-eslint/typescript-estree/dist/create-program/shared.js:59:18
```

Root cause: the repo deliberately adopted `typescript@7.0.2`, the native (Go) port, which ships
**no JS API**. In this repo `require('typescript')` returns exactly
`{ version, versionMajorMinor }` — `ts.Extension`, `ts.ScriptKind` and `ts.createProgram` are all
`undefined`. `typescript-estree/dist/create-program/shared.js` reads `ts.Extension.Cjs` at module
top level, so the parser dies on load. This is not plugin lag: the newest published
`@typescript-eslint/*` (8.66.0) declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`. No
release supports TS 7.

The debt was papered over: `apps/electron` builds via `lint:check`, a
`eslint src/ || echo '⚠️ lint pulado…'` wrapper that swallows the crash and exits 0. The lint gate
exists on paper and has never run. Behind it sit 8 custom rules that encode architecture invariants
(navigation, localStorage, path separator, inline source auth, z-index, shadows, backend boundary,
provider-agnostic fetchers) plus 22 real errors, including 4 hits of the security rule
`craft-shared/no-inline-source-auth-check`.

Neither `overrides` nor yarn-style `resolutions` fixes this: `typescript` is a *peerDependency* of
the `@typescript-eslint` packages, satisfied by the root install. There is no declared dependency
edge for the package manager to override, so no nested copy is ever materialized.

## What Changes

- Add `typescript-for-eslint` (`npm:typescript@5.9.3`) as a root devDependency: a second TypeScript
  with a real JS API, used only by the linter. `typescript` stays at 7.x so `tsc` means TS 7
  everywhere and `typecheck:all` is untouched.
- Add `scripts/link-eslint-typescript.mjs`, run from the root `postinstall`. It walks the dependency
  closure of the lint toolchain (`eslint`, `eslint-plugin-*`, `eslint-config-*`,
  `@typescript-eslint/*`), finds every package that declares `typescript`, and materializes
  `<package>/node_modules/typescript` pointing at the 5.9.3 alias. Node resolution finds the nested
  copy before reaching the root, so the linter sees 5.9.3 and nothing else does.
- Re-enable the gate: `apps/electron` `build` runs `lint` again; the `lint:check` wrapper and its
  `//lint:check` debt comment are removed. CI `validate:ci` runs `bun run lint`.
- Clear all 22 errors: fix the 4 security-rule hits with the mandated `isSourceUsable()` helper, the
  2 `no-direct-file-open` hits with `onOpenFile`, the 1 hardcoded z-index with a token, delete the 2
  dead `jsx-a11y` disable directives (the plugin was never installed), and resolve the 13
  `no-nonstandard-shadows` hits by approved token or documented waiver.
- Document the isolation in `docs/eslint-typescript7.md` and in the AGENTS.md chain, so the next
  person understands why a second `typescript` exists.

## Non-Goals

- Do not replace ESLint with oxlint/biome: the 8 custom rules in `apps/electron/eslint-rules/*.cjs`
  are the value here and do not run elsewhere.
- Do not disable rules to make the gate pass. Waivers are inline, pointed, and carry a reason.
- Do not fix warnings. The 87 warnings (58 `react-hooks/exhaustive-deps`, 13
  `craft-agent/no-localstorage`, 16 unused-directive) stay; changing a dependency array changes
  behavior.
- Do not swap the root `typescript` back to 5.9.x. The alternative route (root 5.9.x + TS 7 by
  explicit path) touches every `typecheck:*` script and makes `tsc` ambiguous; it is only a fallback
  if the preferred route cannot be made deterministic.
- Do not install `eslint-plugin-jsx-a11y`. Loading it would surface a new, unscoped backlog of a11y
  violations; the two errors are dead references to a rule that was never configured.
