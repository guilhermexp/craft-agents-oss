import { CraftOAuth, exchangeMcpOAuth, prepareMcpOAuth, type OAuthCallbacks } from '../auth/oauth.ts';
import type { OAuthSessionContext } from '../auth/types.ts';
import type { OAuthExchangeParams, OAuthExchangeResult, PreparedOAuthFlow } from '../auth/oauth-flow-types.ts';
import type { LoadedSource } from '../sources/types.ts';
import { isCraftProductMcpSource } from './endpoint.ts';

export function sourceUsesCraftBridgeAuth(source: LoadedSource): boolean {
  return isCraftProductMcpSource(source) && source.config.mcp?.authType === 'oauth';
}

export async function prepareCraftBridgeMcpOAuth(
  source: LoadedSource,
  options: { callbackPort?: number; callbackUrl?: string } = {},
): Promise<PreparedOAuthFlow> {
  const url = source.config.mcp?.url;
  if (!url) {
    throw new Error('Craft MCP URL not configured');
  }
  const prepared = await prepareMcpOAuth(url, options);
  return {
    ...prepared,
    provider: 'mcp',
  };
}

export async function exchangeCraftBridgeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  return exchangeMcpOAuth(params);
}

export function createCraftBridgeOAuthClient(
  source: LoadedSource,
  callbacks: OAuthCallbacks,
  sessionContext?: OAuthSessionContext,
): CraftOAuth {
  const url = source.config.mcp?.url;
  if (!url) {
    throw new Error('Craft MCP URL not configured');
  }

  callbacks.onStatus(`Using craft-bridge OAuth adapter for source ${source.config.slug}`);
  return new CraftOAuth({ mcpUrl: url }, callbacks, sessionContext);
}
