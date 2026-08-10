import type { ProviderDriver } from '../driver-types.ts';
import { applyAnthropicRuntimeBootstrap } from '../runtime-resolver.ts';
import { validateAnthropicConnection } from '../../../../config/llm-validation.ts';
import { isKeylessConnection } from '../../../../config/llm-connections.ts';
import { DEFAULT_MODEL, getModelById, getModelContextWindow, normalizeDeprecatedModelId } from '../../../../config/models.ts';
import { KEYLESS_API_KEY_PLACEHOLDER } from '../../../../credentials/types.ts';

export const anthropicDriver: ProviderDriver = {
  provider: 'anthropic',
  initializeHostRuntime: ({ hostRuntime, resolvedPaths }) => {
    // Set paths opportunistically — don't throw on missing.
    // Missing paths will be caught at session start (prepareRuntime).
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths, { strict: false });
  },
  prepareRuntime: ({ hostRuntime, resolvedPaths }) => {
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths);
  },
  buildRuntime: () => ({}),
  fetchModels: async ({ connection, credentials }) => {
    // After legacy migration, only direct 'anthropic' connections reach this driver.
    // iam_credentials and service_account_file are no longer valid auth types for anthropic.

    const apiKey = credentials.apiKey;
    const oauthAccessToken = credentials.oauthAccessToken;

    if (!apiKey && !oauthAccessToken) {
      throw new Error('Anthropic credentials required to fetch models');
    }

    const baseUrl = connection.baseUrl || 'https://api.anthropic.com';
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else {
      headers.authorization = `Bearer ${oauthAccessToken}`;
    }

    const allRawModels: Array<{
      id: string;
      display_name: string;
      created_at: string;
      type: string;
    }> = [];
    let afterId: string | undefined;

    do {
      const params = new URLSearchParams({ limit: '100' });
      if (afterId) params.set('after_id', afterId);

      const response = await fetch(`${baseUrl}/v1/models?${params}`, { headers });
      if (!response.ok) {
        throw new Error(`Anthropic /v1/models failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        data: Array<{ id: string; display_name: string; created_at: string; type: string }>;
        has_more: boolean;
        first_id: string;
        last_id: string;
      };
      if (data.data) allRawModels.push(...data.data);

      if (data.has_more && data.last_id) {
        afterId = data.last_id;
      } else {
        break;
      }
    } while (true);

    if (allRawModels.length === 0) {
      throw new Error('No models returned from Anthropic API');
    }

    const seen = new Set<string>();
    const models = allRawModels.flatMap(m => {
      if (!(m.id.startsWith('claude-') && !m.id.startsWith('claude-2') && !m.id.startsWith('claude-instant') && !m.id.startsWith('claude-1'))) return [];
      // The live Anthropic API can still list deprecated models. Do not persist
      // them back into active connection catalogs at startup.
      if (normalizeDeprecatedModelId(m.id) !== m.id) return [];
      if (seen.has(m.id)) return [];
      seen.add(m.id);
      const registryModel = getModelById(m.id);
      return [{
        id: m.id,
        name: registryModel?.name ?? m.display_name,
        shortName: registryModel?.shortName ?? (() => {
          const stripped = m.id
            .replace('claude-', '')
            .replace(/-\d{8}$/, '')
            .replace(/-latest$/, '');
          const variant = stripped
            .replace(/^[\d.-]+/, '')
            .replace(/-[\d.]+$/, '')
            .replace(/^-/, '');
          return variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : stripped;
        })(),
        description: registryModel?.description ?? '',
        descriptionKey: registryModel?.descriptionKey,
        provider: 'anthropic' as const,
        contextWindow: getModelContextWindow(m.id) ?? 200_000,
        supportsThinking: registryModel?.supportsThinking,
        supportsImages: registryModel?.supportsImages,
      }];
    });

    return {
      models,
      serverDefault: models.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id,
    };
  },
  validateStoredConnection: async ({ slug, connection, credentialManager }) => {
    // After legacy migration, only direct 'anthropic' connections reach this driver.

    if (connection.providerType === 'anthropic' && connection.authType === 'oauth') {
      const { getValidClaudeOAuthToken } = await import('../../../../auth/state.ts');
      const tokenResult = await getValidClaudeOAuthToken(slug);
      if (!tokenResult.accessToken) {
        const errorMsg = tokenResult.migrationRequired?.message || 'OAuth token expired. Please re-authenticate.';
        return { success: false, error: errorMsg };
      }
      return { success: true };
    }

    // Value fetching is delegated to the single authType -> credential resolver.
    // The OAuth-provider case is handled above (it needs token refresh); the
    // remaining kinds map onto the SDK's x-api-key vs Bearer inputs here.
    const resolved = await credentialManager.resolveLlmCredential(
      slug,
      connection.authType,
      connection.providerType,
    );

    let apiKey: string | undefined;
    let oauthToken: string | undefined;
    if (isKeylessConnection(connection, resolved)) {
      // Keyless endpoint (e.g. local Anthropic-compatible proxy). Same predicate
      // drives resolveAuthEnvVars, so a keyless session and this Test agree.
      apiKey = KEYLESS_API_KEY_PLACEHOLDER;
    } else if (!resolved) {
      // 'environment' names a single variable we can surface in the diagnostic;
      // every other arm only knows the credential is absent.
      if (connection.authType === 'environment') {
        return { success: false, error: 'ANTHROPIC_API_KEY environment variable not set' };
      }
      return { success: false, error: 'Could not retrieve credentials' };
    } else {
      switch (resolved.kind) {
        case 'oauth':
          oauthToken = resolved.accessToken || undefined;
          break;
        case 'api_key':
        case 'environment':
          // bearer_token stores its secret as an api key but sends it as a Bearer token.
          if (connection.authType === 'bearer_token') {
            oauthToken = resolved.value || undefined;
          } else {
            apiKey = resolved.value || undefined;
          }
          break;
        // 'none' is handled by isKeylessConnection above; 'iam' / 'service_account'
        // are not valid auth for the anthropic provider and fall through unset.
      }
    }

    // An empty ('') or absent secret carries no usable auth: never hand
    // validateAnthropicConnection an unauthenticated request.
    if (!apiKey && !oauthToken) {
      return { success: false, error: 'Could not retrieve credentials' };
    }

    const testModel = connection.defaultModel!;
    const validationResult = await validateAnthropicConnection({
      model: testModel,
      apiKey,
      oauthToken,
      baseUrl: connection.baseUrl || undefined,
    });

    if (!validationResult.success) {
      return { success: false, error: validationResult.error };
    }

    return { success: true };
  },
};
