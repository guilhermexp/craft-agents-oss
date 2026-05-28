/**
 * Credential strategy registry.
 *
 * Resolves a LoadedSource to the matching CredentialStrategy.
 * Strategies handle only provider-specific OAuth prepare/exchange/refresh
 * logic; cross-cutting concerns stay in SourceCredentialManager.
 *
 * Order matters: strategies are tested sequentially and the first match wins.
 * ApiRenew is first because api.renewEndpoint should take priority over
 * provider-type routing.
 */

import type { CredentialStrategy } from './types.ts';
import type { LoadedSource } from '../types.ts';
import { ApiRenewCredentialStrategy } from './api-renew.ts';
import { GoogleCredentialStrategy } from './google.ts';
import { SlackCredentialStrategy } from './slack.ts';
import { MicrosoftCredentialStrategy } from './microsoft.ts';
import { GenericOAuthCredentialStrategy } from './generic-oauth.ts';
import { McpOAuthCredentialStrategy } from './mcp-oauth.ts';

const STRATEGIES: CredentialStrategy[] = [
  // ApiRenew first -- sources with renewEndpoint bypass normal provider routing
  new ApiRenewCredentialStrategy(),
  // Named providers
  new GoogleCredentialStrategy(),
  new SlackCredentialStrategy(),
  new MicrosoftCredentialStrategy(),
  // Catch-all OAuth strategies
  new GenericOAuthCredentialStrategy(),
  new McpOAuthCredentialStrategy(),
];

/**
 * Find the credential strategy that handles the given source.
 * Returns null if no strategy matches.
 */
export function resolveCredentialStrategy(source: LoadedSource): CredentialStrategy | null {
  return STRATEGIES.find(s => s.canHandle(source)) ?? null;
}

/**
 * Register an additional credential strategy at runtime.
 * Useful for plugin providers or test overrides.
 */
export function registerCredentialStrategy(strategy: CredentialStrategy): void {
  STRATEGIES.push(strategy);
}

export type {
  CredentialStrategy,
  OAuthPrepareOptions,
  RefreshResult,
} from './types.ts';
