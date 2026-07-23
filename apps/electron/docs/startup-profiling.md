# Startup / RAM profiling (Track B)

Profiling pass that accompanies the `optimize-app-bundle-size` change. The disk
wins (T1–T3) shrink the packaged `.app`; this track looks at boot latency and
idle memory. It is intentionally low-risk: it adds **instrumentation** and
records **findings**, and only applies fixes that cannot change behavior.

## Instrumentation added (behavior-preserving)

| Hotspot | Where | What it logs |
| ------- | ----- | ------------ |
| `loadShellEnv()` | `apps/electron/src/main/shell-env.ts` | Elapsed ms of the synchronous login+interactive shell spawn. Visible in `main.log` in packaged builds (the perf util is dev-only, but this path only runs in packaged/non-dev macOS). |
| On-launch asset seeding | `apps/electron/src/main/index.ts` (`app.whenReady`) | Elapsed ms to seed permissions + tool-icons + preset themes to `~/.craft-agent`. |

`main.log` lines to grep after launching the packaged app:

```
[shell-env] Loaded N environment variables in <ms>ms
[boot] Seeded permissions/tool-icons/preset-themes in <ms>ms
```

## Findings

1. **`loadShellEnv()` is a synchronous `execSync` of a `-l -i` login shell** run
   at the very top of `index.ts`, before `uv`/`PATH` resolution and before the
   Electron `app` import. It sources `.zprofile` + `.zshrc`, so its cost tracks
   the user's shell config (commonly 100–800 ms; capped at the existing
   `timeout: 5000`). It is the single largest deterministic blocker on cold
   start for packaged macOS builds. It is **skipped in dev** (already has the
   terminal environment) and **skipped on non-macOS**.
2. **On-launch asset seeding copies bundled assets to `~/.craft-agent` on every
   launch** (docs, permissions, tool-icons, preset themes). It is dominated by
   filesystem copies that mostly no-op after first run, but still stats/copies
   each launch.
3. **App-level `theme.json`** is a small user override file; the large theme
   payload is the bundled preset theme set copied by `ensurePresetThemes()`
   (also covered by the seeding timer above).
4. **Workspace enumeration** (`getWorkspaces()`) runs synchronously during
   window bring-up; cost scales with the number of workspace directories.

## Applied fixes

- Instrumentation above (safe, always-on logging).
- No behavioral boot change is applied here: making `loadShellEnv()` async would
  reorder it relative to the synchronous `uv`/`PATH` wiring that depends on it,
  and a disk cache needs invalidation semantics — both require a running-app
  measurement to verify and are therefore deferred rather than shipped blind.

## Follow-ups (deferred — need a running-app measurement to verify)

- **Cache `loadShellEnv()` output** keyed by shell + rc-file mtimes under
  `~/.craft-agent`, refreshing in the background, so cold start skips the
  synchronous shell spawn while still picking up user PATH changes.
- **Skip re-seeding unchanged bundled assets** by comparing a bundle version /
  content hash instead of copying every launch.
- **Idle heap (8.2)**: capture RSS/heap for the main, renderer, and server-WS
  processes from a running packaged app (e.g. `process.memoryUsage()` sampled at
  idle, or Activity Monitor). This requires launching the packaged build and was
  not measurable statically; the instrumentation above is the entry point for a
  follow-up capture.

## Measured (this pass)

- **Packaged `.app` size**: 981 MB (baseline) → 839 MB after this change
  (−142 MB), macOS arm64, `du -sh`. Delta breakdown: `vendor/hermes` 345→222 MB
  (Playwright removed), `dist` 180→128 MB (main.cjs minified + sourcemap moved
  out-of-band + `dist/resources` dedup), duplicated `dist/resources/bin` uv
  (−42 MB) and installer assets (−13.5 MB) gone.
- **Idle main-process RSS**: ~357 MB shortly after boot of the packaged app
  (single `ps` sample; renderer + server-WS not separately captured — see the
  8.2 follow-up).

## Packaging leaks discovered (pre-existing — out of scope for the 5 named tasks)

During the size measurement, two pre-existing sources of `.app` bloat surfaced.
They are present in both the baseline and the after build (so they cancel in the
delta) and are **not** part of T1–T3, but are worth a follow-up:

- **Renderer sourcemaps ship in the `.app`.** `electron-builder.yml` carries a
  `!**/*.map` negation, but electron-builder splits the config into two filesets
  and the app files are copied by the default `**/*` fileset
  (`firstOrDefaultFilePatterns`), which does not carry that negation, so all
  `dist/renderer/assets/*.js.map` files (322 of them) are packaged. The
  main-process map is now moved out of `dist/` to dodge this; the renderer maps
  would need the negation applied to the app fileset (or `build.sourcemap`
  scoped) to be excluded.
- **`app/scripts` (~83 MB)** is shipped whole via the same `**/*` app fileset,
  including `apps/electron/scripts/.hermes-cache/` (the throwaway upstream Hermes
  clone). Excluding `scripts/.hermes-cache` (and dev-only script sources) from
  the package is a sizeable additional win.

## Build gotchas (macOS packaging)

- **`electron-builder` falha no rebuild nativo com Electron 43.1.1.** O
  `@electron/rebuild` empacotado traz um `node-abi` antigo demais e aborta com
  *"Could not detect abi for version 43.1.1"* ao empacotar. Contorno usado nesta
  change: `electron-builder --mac -c.npmRebuild=false`, reusando o
  `better_sqlite3.node` já compilado com a ABI do Electron em `node_modules`.
  Nenhuma dependência nova foi instalada e o `electron-builder.yml` não foi
  alterado. Remover o contorno só quando o `node-abi` do `@electron/rebuild`
  reconhecer o Electron 43.
- **`electron:dist:dev:mac` re-clona o cache do Hermes e faz `rm -rf` em
  `resources/vendor/hermes` antes de reconstruir** (via `bundle-hermes.sh`).
  Precisa de rede; num rebuild que falhe, o runtime de trabalho é destruído.
  Ao iterar localmente, faça backup de `vendor/hermes` (ou rode os sub-passos
  `bundle-hermes.sh` → `electron:build` → `electron-builder --mac` separados).

## Validação visual (orquestrador)

O `.app` empacotado (com esta change) foi aberto via `background-computer-use`
e confirmado por screenshot: a UI completa renderiza e os blocos de código
aparecem com highlight colorido (Shiki lazy-load) — nenhuma linguagem perde
highlight. Backends intactos (seletor Hermes presente). Não validado ao vivo:
join no Google Meet com download on-demand do Playwright (task 7.4) e amostra de
heap idle multi-processo (task 8.2).
