// Stub for `electron-log/main`, aliased in vite.config.ts.
// packages/shared/src/utils/debug.ts optionally requires it (main process
// only, inside try/catch). The renderer never takes that code path, but
// Vite's dependency scanner still tries to resolve the import and aborts
// pre-bundling when it can't. Consumers call `log?.info?.()`, so an empty
// object is safe.
export default {}
