import type { AuthInteraction, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

/**
 * Resolve the github-copilot OAuthAuth flow from the Pi SDK provider catalog.
 *
 * Pi SDK 0.80.8 removed the runtime exports from `@earendil-works/pi-ai/oauth`
 * (now a type-only entry). The flow lives on the github-copilot provider's
 * OAuthAuth. `registerBunOAuthFlows()` statically registers the flow modules
 * so bundled builds don't depend on the SDK's variable-specifier dynamic
 * import (which cannot resolve inside a bundle).
 */
function resolveCopilotOAuth(): OAuthAuth {
  registerBunOAuthFlows();
  const oauth = githubCopilotProvider().auth?.oauth;
  if (!oauth) {
    throw new Error('GitHub Copilot OAuth flow unavailable in Pi SDK');
  }
  return oauth;
}

/**
 * Exchange a long-lived GitHub OAuth token for a short-lived Copilot API token.
 *
 * Returns the SDK OAuthCredential: `access` is the Copilot API token,
 * `refresh` echoes the GitHub token, `expires` is epoch ms.
 */
export async function refreshGitHubCopilotToken(githubToken: string): Promise<OAuthCredential> {
  return resolveCopilotOAuth().refresh({ type: 'oauth', refresh: githubToken, access: '', expires: 0 });
}

/**
 * Run the GitHub Copilot device-code login flow.
 *
 * The interaction receives the SDK's enterprise-domain prompt (return '' for
 * github.com) and `device_code` / `progress` notifications.
 */
export async function loginGitHubCopilot(interaction: AuthInteraction): Promise<OAuthCredential> {
  return resolveCopilotOAuth().login(interaction);
}
