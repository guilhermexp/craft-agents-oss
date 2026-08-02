export function getPublicOAuthProviderError(
  _providerError?: string,
  _providerDescription?: string,
): string {
  return 'OAuth authorization failed';
}

export function getPublicOAuthFlowError(_error: unknown): string {
  return 'OAuth flow failed';
}
