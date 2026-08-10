/**
 * Credential Storage Module
 *
 * Provides secure credential storage using AES-256-GCM encrypted file.
 * All methods auto-initialize, so explicit initialize() calls are optional.
 *
 * Usage:
 *   import { getCredentialManager } from './credentials';
 *
 *   const manager = getCredentialManager();
 *
 *   // Get/set API key
 *   const apiKey = await manager.getApiKey();
 *   await manager.setApiKey('sk-ant-...');
 *
 *   // Get/set workspace OAuth
 *   const oauth = await manager.getWorkspaceOAuth(workspaceId);
 *   await manager.setWorkspaceOAuth(workspaceId, { accessToken, refreshToken, ... });
 *
 *   // Get/set agent MCP/API credentials
 *   const mcpCreds = await manager.getMcpOAuth(wsId, agentId, serverName);
 *   const apiKey = await manager.getApiKeyForAgent(wsId, agentId, apiName);
 */

export { CredentialManager, getCredentialManager } from './manager.ts';
export type { ResolvedLlmCredential } from './manager.ts';
export type { CredentialId, CredentialType, StoredCredential } from './types.ts';
// NOTE: this barrel re-exports `CredentialManager` from `./manager.ts`, so any
// import from `@craft-agent/shared/credentials` drags the Node-only
// `backends/secure-storage.ts` (`node:crypto`) into the module graph. Renderer
// code that only needs `KEYLESS_API_KEY_PLACEHOLDER` must import it directly
// from `./types.ts` (a zero-dependency module) to keep it out of the browser
// bundle. See the JSDoc on the constant in `types.ts`.
export { credentialIdToAccount, accountToCredentialId, SOURCE_CREDENTIAL_TYPES, KEYLESS_API_KEY_PLACEHOLDER } from './types.ts';
export type { CredentialBackend } from './backends/types.ts';
