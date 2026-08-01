const SAFE_PORTABLE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

export type SourceTestFailureCode =
  | 'api-connection-failed'
  | 'api-validation-failed'
  | 'icon-download-failed'
  | 'mcp-connection-failed'
  | 'mcp-validation-failed'
  | 'source-activation-failed'
  | 'source-activation-exception'

/** Raw failures are classification input only; no caller may serialize them. */
export function redactSourceTestFailure(
  _rawFailure: unknown,
  code: SourceTestFailureCode,
): SourceTestFailureCode {
  return code
}

/** Allow only portable identity metadata at source-test result boundaries. */
export function redactSourceTestMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_PORTABLE_VALUE.test(value) ? value : undefined
}
