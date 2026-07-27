/**
 * Complete stub namespace for `apps/electron/src/main/logger.ts`.
 *
 * `mock.module` replaces a module for every file in the same test process, so a
 * factory that returns only the handful of exports one suite happens to use
 * strips the rest from unrelated suites that run later. That produced
 * "Missing 'default' export in module .../logger.ts" failures in
 * `browser-pane-manager.test.ts`, which declares its own complete mock and was
 * merely the victim of a sibling's partial one.
 *
 * The real module is deliberately not imported: loading it writes into
 * `~/.craft-agent/logs`.
 */

export interface LoggerStub {
  info: () => void
  warn: () => void
  error: () => void
  debug: () => void
  scope: () => LoggerStub
}

export function createLoggerStub(): LoggerStub {
  const stub: LoggerStub = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    scope: () => stub,
  }
  return stub
}

/**
 * Build the full `../logger` namespace. Pass `overrides` to observe calls from a
 * single suite without dropping the other exports.
 */
export function createLoggerModuleStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stub = createLoggerStub()
  return {
    default: stub,
    mainLog: stub,
    windowLog: stub,
    messagingGatewayLog: stub,
    isDebugMode: false,
    messagingGatewayLogPath: '/tmp/craft-test-messaging-gateway.log',
    getLogFilePath: () => undefined,
    getMessagingGatewayLogFilePath: () => '/tmp/craft-test-messaging-gateway.log',
    ...overrides,
  }
}
