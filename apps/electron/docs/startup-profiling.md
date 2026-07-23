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
