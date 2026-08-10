# Why this repo installs two TypeScripts

`typescript` is pinned to the **7.x native port**, and there is a second install,
`typescript-for-eslint` (`npm:typescript@5.9.3`), that only the ESLint toolchain can see.
This document exists because the reason is not guessable from the diff.

## The failure it prevents

`typescript@7` is the Go port. It ships a `tsc` binary and no JS compiler API:

```
$ node -e "console.log(Object.keys(require('typescript')))"
[ 'version', 'versionMajorMinor' ]
```

`ts.Extension`, `ts.ScriptKind`, `ts.Intrinsic` and `ts.createProgram` are all `undefined`.
`@typescript-eslint/typescript-estree/dist/create-program/shared.js` reads `ts.Extension.Cjs` at
module top level, so ESLint dies while loading the parser — before it opens a single source file:

```
Oops! Something went wrong! :(
ESLint: 10.7.0
TypeError: Cannot read properties of undefined (reading 'Cjs')
    at node_modules/@typescript-eslint/typescript-estree/dist/create-program/shared.js:59:18
```

This is not plugin lag. The newest published `@typescript-eslint/*` declares
`peerDependencies.typescript: ">=4.8.4 <6.1.0"`; no release supports TS 7. Fixing it by waiting
for upstream is not a plan.

## Why `overrides` and `resolutions` cannot fix it

`typescript` is a **peerDependency** of every `@typescript-eslint/*` package and of
`ts-api-utils`, satisfied by the root install. There is no declared dependency edge for the
package manager to rewrite, so neither of these materializes a nested copy:

```jsonc
"overrides":    { "@typescript-eslint/typescript-estree": { "typescript": "5.9.3" } }  // no-op
"resolutions":  { "@typescript-eslint/typescript-estree/typescript": "5.9.3" }         // no-op
```

Both were tried against `bun install` and both left the crash in place.

## What actually happens

`scripts/link-eslint-typescript.mjs` runs from the root `postinstall`. It walks the dependency
closure of the lint toolchain — `eslint`, `eslint-plugin-*`, `eslint-config-*`,
`@typescript-eslint/*` — collects every package that declares `typescript` in
`dependencies`/`peerDependencies`/`optionalDependencies`, and materializes
`<package>/node_modules/typescript` pointing at `node_modules/typescript-for-eslint`
(a junction on Windows). Node resolution finds that nested copy before it reaches the root, so
the linter sees 5.9.3 and nothing else in the repo does.

Today that closure is 8 packages:

| package | why it loads `typescript` |
|---|---|
| `@typescript-eslint/parser` | entry point used by every flat config |
| `@typescript-eslint/typescript-estree` | `ts.Extension.Cjs` at module top level — first crash |
| `@typescript-eslint/eslint-plugin` | typed rules |
| `@typescript-eslint/type-utils` | type-aware helpers |
| `@typescript-eslint/utils` | shared rule utilities |
| `@typescript-eslint/project-service` | program/project resolution |
| `@typescript-eslint/tsconfig-utils` | tsconfig parsing |
| `ts-api-utils` | `ts.Intrinsic` — second crash, only visible after the first is fixed |

The list is **discovered, not hardcoded**. Add a lint plugin that consumes `typescript` and the
next `bun install` covers it automatically. Do not replace the walk with a literal array.

## Invariants

- `typescript` at the root stays 7.x. `tsc` means TS 7 in every `typecheck:*` script, and
  `bun run typecheck:all` must keep passing. Never "fix" a lint problem by downgrading the root.
- `typescript-for-eslint` must satisfy `>=4.8.4 <6.1.0`. The script refuses a non-5.x alias.
- The script is idempotent, fails loudly when the alias is missing (a silent skip means a linter
  that crashes on the next run), and never replaces a real nested `typescript` directory that a
  package manager installed on purpose.
- Reproducibility is the whole point: a clean checkout plus `bun install` must be lintable with no
  manual step. If you break the `postinstall` binding, the crash comes back on every fresh clone
  and CI.

## Retiring this

When `@typescript-eslint` publishes a release whose `peerDependencies.typescript` admits 7.x:
drop `typescript-for-eslint` from the root `devDependencies`, delete
`scripts/link-eslint-typescript.mjs` and the `postinstall` entry, delete this document, then run
`rm -rf node_modules && bun install && bun run lint` to confirm the parser loads against the root
TypeScript.
