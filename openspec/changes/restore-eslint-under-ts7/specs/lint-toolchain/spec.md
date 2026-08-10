## ADDED Requirements

### Requirement: The linter runs under a TypeScript that has a JS API
The repository SHALL keep `typescript` at the native 7.x port for `tsc` while providing the
`@typescript-eslint` toolchain with a TypeScript 5.9.x install that exposes the JS compiler API.
The 5.9.x copy SHALL be reachable only from the lint dependency closure, so no typecheck, build or
runtime path resolves it.

#### Scenario: ESLint loads instead of crashing on `ts.Extension`
- **WHEN** `eslint` is invoked in `apps/electron`, `packages/shared` or `packages/ui`
- **THEN** the parser loads and files are linted
- **AND** it does not fail with `TypeError: Cannot read properties of undefined (reading 'Cjs')`

#### Scenario: `tsc` still means TypeScript 7
- **WHEN** `bun run typecheck:all` runs
- **THEN** every package typechecks with the root `typescript` 7.x
- **AND** the command exits 0

#### Scenario: Every lint-tree consumer of `typescript` is covered
- **WHEN** the isolation step runs
- **THEN** it resolves the `typescript` consumers reachable from `eslint`, `eslint-plugin-*`,
  `eslint-config-*` and `@typescript-eslint/*`, rather than a hardcoded list
- **AND** a lint plugin added later that consumes `typescript` is covered without editing the script

### Requirement: Lint isolation is reproducible from a clean install
The isolation SHALL be produced by committed repository code bound to the install lifecycle. A
clean checkout followed by `bun install` SHALL leave the repository lintable with no manual step,
no hand-created symlink and no machine-specific state.

#### Scenario: Clean install yields a working linter
- **WHEN** `node_modules` is removed and `bun install` is run, followed by `bun run lint`
- **THEN** the lint run reports per-file results and exits 0

#### Scenario: Missing alias fails loudly
- **WHEN** the isolation step runs and the TypeScript 5.9.x alias package is absent
- **THEN** it reports a non-zero exit with a message naming the missing package and the crash it
  prevents
- **AND** it does not silently leave a broken linter behind

#### Scenario: A real nested install is not clobbered
- **WHEN** a consumer already carries its own real `node_modules/typescript` directory
- **THEN** the isolation step leaves that directory in place and reports it

### Requirement: The lint gate is enforced, not simulated
The Electron build SHALL fail on lint errors. No build or CI path SHALL wrap the linter in a
construct that discards its exit code, and no script comment SHALL describe the linter as
permanently disabled debt.

#### Scenario: Electron build blocks on lint errors
- **WHEN** `apps/electron` runs its `build` script and the linter reports an error
- **THEN** the build fails
- **AND** the failure is not masked by an `|| echo` fallback

#### Scenario: CI runs the linter
- **WHEN** the `validate:ci` pipeline runs
- **THEN** it runs the repository lint target
- **AND** a lint error fails the pipeline

### Requirement: The repository lints clean of errors
`apps/electron`, `packages/shared` and `packages/ui` SHALL report zero ESLint errors. Warnings are
permitted and are not part of this requirement. Where a style rule cannot be satisfied without a
design decision, the exception SHALL be an explicit, file-scoped waiver carrying an inline reason,
never a globally disabled rule.

#### Scenario: All three targets are error-free
- **WHEN** the linter runs over `apps/electron/src`, `packages/shared` and `packages/ui`
- **THEN** each reports 0 errors

#### Scenario: Inline source auth checks use the shared helper
- **WHEN** code needs to know whether a source is authenticated
- **THEN** it calls `isSourceUsable()` rather than reading `source.config.isAuthenticated` inline

#### Scenario: File opening goes through the link interceptor
- **WHEN** renderer code opens a file on the user's behalf
- **THEN** it calls `onOpenFile` from the app shell/platform context rather than
  `window.electronAPI.openFile()` directly

#### Scenario: A disable directive never names an unloaded rule
- **WHEN** the configuration does not load a plugin
- **THEN** no source file carries an `eslint-disable` directive referencing that plugin's rules

#### Scenario: Shadow waivers are documented, not invented
- **WHEN** a disallowed shadow has no obvious approved-token equivalent
- **THEN** the file is added to the configuration's documented shadow-exception block with a reason
- **AND** the shadow itself is left visually unchanged
