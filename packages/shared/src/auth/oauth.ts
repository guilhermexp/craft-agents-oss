import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { generateCallbackPage } from './callback-page.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

export interface OAuthConfig {
  mcpUrl: string; // Full MCP URL including path (e.g., https://mcp.craft.do/my/mcp)
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

// Port range for OAuth callback server - tries ports sequentially until one is available
const CALLBACK_PORT_START = 8914;
const CALLBACK_PORT_END = 8924;
const CALLBACK_PATH = '/oauth/callback';
const CLIENT_NAME = 'Claude Code (Craft Agent)';

// Generate PKCE code verifier and challenge
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Generate random state for CSRF protection
function generateState(): string {
  return randomBytes(16).toString('hex');
}

export class CraftOAuth {
  private config: OAuthConfig;
  private server: Server | null = null;
  private callbacks: OAuthCallbacks;
  private sessionContext?: OAuthSessionContext;

  constructor(config: OAuthConfig, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext) {
    this.config = config;
    this.callbacks = callbacks;
    this.sessionContext = sessionContext;
  }

  // Get OAuth server metadata using progressive discovery
  private async getServerMetadata(): Promise<OAuthMetadata> {
    const metadata = await discoverOAuthMetadata(this.config.mcpUrl);

    if (!metadata) {
      throw new Error('oauth-metadata-unavailable');
    }

    return metadata;
  }

  // Register OAuth client dynamically
  private async registerClient(registrationEndpoint: string, port: number): Promise<{
    client_id: string;
    client_secret?: string;
  }> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    assertSafeOAuthEndpoint(registrationEndpoint, 'registration endpoint');
    const response = await fetchWithTimeout(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // Public client
      }),
    }, OAUTH_ENDPOINT_TIMEOUT_MS);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('oauth-client-registration-failed');
    }

    return response.json() as Promise<{
      client_id: string;
      client_secret?: string;
    }>;
  }

  // Exchange authorization code for tokens
  private async exchangeCodeForTokens(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    clientId: string,
    port: number
  ): Promise<OAuthTokens> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    assertSafeOAuthEndpoint(tokenEndpoint, 'token endpoint');
    const response = await fetchWithTimeout(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }, OAUTH_ENDPOINT_TIMEOUT_MS);

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('oauth-token-exchange-failed');
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    // Default to 3600s (1 hour) if server doesn't return expires_in.
    // Most OAuth access tokens expire in 1 hour per RFC 6749.
    // Without this, tokens with no expiresAt are never detected as needing refresh.
    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Refresh access token
  async refreshAccessToken(
    refreshToken: string,
    clientId: string
  ): Promise<OAuthTokens> {
    const metadata = await this.getServerMetadata();

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });

    assertSafeOAuthEndpoint(metadata.token_endpoint, 'token endpoint');
    const response = await fetchWithTimeout(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }, OAUTH_ENDPOINT_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Check if the MCP server requires OAuth
  async checkAuthRequired(): Promise<boolean> {
    this.callbacks.onStatus('Checking if authentication is required...');

    try {
      const metadata = await discoverOAuthMetadata(
        this.config.mcpUrl,
        (msg) => this.callbacks.onStatus(msg)
      );

      if (metadata) {
        this.callbacks.onStatus('OAuth required - server has OAuth metadata');
        return true;
      }

      // No metadata found at any candidate URL
      this.callbacks.onStatus('No OAuth metadata found - server may be public');
      return false;
    } catch (error) {
      this.callbacks.onStatus('Could not reach OAuth metadata - assuming public');
      return false;
    }
  }

  // Start the OAuth flow
  async authenticate(): Promise<{ tokens: OAuthTokens; clientId: string }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');

    // 1. Get server metadata — no port dependency
    let metadata;
    try {
      metadata = await this.getServerMetadata();
      this.callbacks.onStatus('OAuth server configuration found');
    } catch {
      this.callbacks.onStatus('OAuth server configuration unavailable');
      throw new Error('oauth-metadata-unavailable');
    }

    // 2. Generate PKCE and state — no dependencies
    const pkce = generatePKCE();
    const state = generateState();
    this.callbacks.onStatus('Generated PKCE challenge and state');

    // 3. Start callback server — binds directly with retry, returns the bound port.
    //    This must happen before client registration because the redirect_uri
    //    includes the port, and we need the *actually bound* port (not a checked-
    //    then-released one) to avoid a TOCTOU race condition.
    this.callbacks.onStatus('Starting callback server...');
    let port: number;
    let codePromise: Promise<string>;
    try {
      const server = await this.startCallbackServer(state);
      port = server.port;
      codePromise = server.codePromise;
      this.callbacks.onStatus(`Callback server listening on port ${port}`);
    } catch {
      this.callbacks.onStatus('OAuth callback server failed to start');
      throw new Error('oauth-callback-server-failed');
    }

    // 4. Register client if endpoint available — now has the bound port
    let clientId: string;
    if (metadata.registration_endpoint) {
      this.callbacks.onStatus('Registering OAuth client...');
      try {
        const client = await this.registerClient(metadata.registration_endpoint, port);
        clientId = client.client_id;
        this.callbacks.onStatus('OAuth client registered');
      } catch {
        // Clean up the callback server if registration fails
        this.stopServer();
        this.callbacks.onStatus('OAuth client registration failed');
        throw new Error('oauth-client-registration-failed');
      }
    } else {
      // Use a default client ID for public clients
      clientId = 'craft-agent';
      this.callbacks.onStatus('Using default OAuth client');
    }

    // 5. Build authorization URL
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // 6. Open browser for authorization
    this.callbacks.onStatus('Opening browser for authorization...');
    await openUrl(authUrl.toString());

    // 7. Wait for the authorization code
    this.callbacks.onStatus('Waiting for you to authorize in browser...');
    const authCode = await codePromise;
    this.callbacks.onStatus('Authorization code received!');

    // 8. Exchange code for tokens
    this.callbacks.onStatus('Exchanging authorization code for tokens...');
    const tokens = await this.exchangeCodeForTokens(
      metadata.token_endpoint,
      authCode,
      pkce.verifier,
      clientId,
      port
    );
    this.callbacks.onStatus('Tokens received successfully!');

    return { tokens, clientId };
  }

  /**
   * Start the OAuth callback server by binding directly to a port in the range
   * CALLBACK_PORT_START .. CALLBACK_PORT_END.
   *
   * Eliminates the TOCTOU race condition: the port returned is the port the
   * server is actually listening on — there is no gap between checking and
   * binding. On EADDRINUSE the candidate server is closed and the next port
   * is tried.
   *
   * Returns immediately once the server is bound, with a `codePromise` that
   * resolves when the OAuth callback delivers the authorization code.
   */
  private async startCallbackServer(
    expectedState: string
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    // Set up the deferred code promise — resolved/rejected by the request handler
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const timeout = setTimeout(() => {
      this.stopServer();
      rejectCode(new Error('OAuth timeout - no callback received'));
    }, 300000); // 5 minute timeout

    // Try binding on each candidate port in the range
    for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
      const candidate = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname === CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: error,
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Security Error',
              isSuccess: false,
              errorDetail: 'State mismatch - possible CSRF attack.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: 'No authorization code received.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('No authorization code'));
            return;
          }

          // Success!
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(generateCallbackPage({
            title: 'Authorization Successful',
            isSuccess: true,
            deeplinkUrl: buildOAuthDeeplinkUrl(this.sessionContext),
          }));

          clearTimeout(timeout);
          this.stopServer();
          resolveCode(code);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(port, 'localhost', () => {
            candidate.removeListener('error', reject);
            resolve();
          });
        });

        // Bind succeeded — keep this server
        this.server = candidate;
        this.server.on('error', (err) => {
          clearTimeout(timeout);
          rejectCode(new Error(`Callback server error: ${err.message}`));
        });
        return { port, codePromise };
      } catch (err: unknown) {
        // Port in use — close the candidate and try the next one
        candidate.close();
        const isAddressInUse =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (!isAddressInUse) {
          // Unexpected error — clean up and propagate
          clearTimeout(timeout);
          throw err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // All ports exhausted
    clearTimeout(timeout);
    throw new Error(
      `All OAuth callback ports (${CALLBACK_PORT_START}-${CALLBACK_PORT_END}) are in use. Please restart the application.`
    );
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // Cancel the OAuth flow
  cancel(): void {
    this.stopServer();
  }
}

/**
 * Register an MCP OAuth client dynamically.
 * Extracted from CraftOAuth.registerClient for reuse in prepareMcpOAuth.
 */
class McpClientRegistrationError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpClientRegistrationError';
    this.status = status;
  }
}

function shouldFallbackToDefaultMcpClient(error: unknown): boolean {
  return error instanceof McpClientRegistrationError && (error.status === 401 || error.status === 403);
}

async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  assertSafeOAuthEndpoint(registrationEndpoint, 'registration endpoint');
  let response: Response;
  try {
    response = await fetchWithTimeout(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }, OAUTH_ENDPOINT_TIMEOUT_MS);
  } catch {
    throw new McpClientRegistrationError('oauth-client-registration-failed');
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpClientRegistrationError('oauth-client-registration-failed', response.status);
  }

  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}

/**
 * Exchange an MCP authorization code for tokens (standalone, no class instance needed).
 */
async function exchangeMcpCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  assertSafeOAuthEndpoint(tokenEndpoint, 'token endpoint');
  const response = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, OAUTH_ENDPOINT_TIMEOUT_MS);

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('oauth-token-exchange-failed');
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const expiresIn = data.expires_in ?? 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: data.token_type || 'Bearer',
  };
}

/**
 * Prepare an MCP OAuth flow without starting a callback server or opening a browser.
 *
 * Performs metadata discovery, PKCE generation, optional client registration,
 * and auth URL construction. Accepts either callbackPort (Electron) or
 * callbackUrl (WebUI) to construct the redirect URI.
 */
export async function prepareMcpOAuth(
  mcpUrl: string,
  options: { callbackPort?: number; callbackUrl?: string },
): Promise<PreparedOAuthFlow> {
  const metadata = await discoverOAuthMetadata(mcpUrl);
  if (!metadata) {
    throw new Error('oauth-metadata-unavailable');
  }

  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}${CALLBACK_PATH}`;

  let clientId: string;
  let clientSecret: string | undefined;
  if (metadata.registration_endpoint) {
    try {
      const client = await registerMcpOAuthClient(metadata.registration_endpoint, redirectUri);
      clientId = client.client_id;
      clientSecret = client.client_secret;
    } catch (error) {
      if (!shouldFallbackToDefaultMcpClient(error)) {
        throw error;
      }

      // Dynamic client registration can be intentionally gated by providers
      // (for example returning 403 for unapproved clients). In that case,
      // fall back to a default client ID and proceed with the flow.
      clientId = 'craft-agent';
    }
  } else {
    clientId = 'craft-agent';
  }

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    clientSecret,
    redirectUri,
    provider: 'mcp',
  };
}

/**
 * Exchange an MCP authorization code for tokens (server-side).
 */
export async function exchangeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeMcpCodeForTokens(
      params.tokenEndpoint,
      params.code,
      params.codeVerifier,
      params.clientId,
      params.redirectUri
    );

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      oauthClientId: params.clientId,
    };
  } catch {
    return {
      success: false,
      error: 'OAuth token exchange failed',
      errorCode: 'oauth-token-exchange-failed',
    };
  }
}

/**
 * Extract the origin (scheme + host + port) from an MCP URL.
 * This is the base URL for OAuth discovery per RFC 8414.
 */
export function getMcpBaseUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    // If URL parsing fails, return as-is and let caller handle it
    return mcpUrl;
  }
}

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/**
 * Try to fetch OAuth authorization server metadata from a specific URL.
 * Returns the metadata if successful, null if not found or error.
 */
async function tryFetchAuthServerMetadata(
  url: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.('  Trying OAuth metadata endpoint');
    const response = await fetchWithTimeout(url);
    if (response.ok) {
      const data = await response.json() as OAuthMetadata;
      if (data.authorization_endpoint && data.token_endpoint) {
        // SSRF protection: reject metadata whose fetchable endpoints point
        // at private/internal addresses before any downstream fetch uses them.
        for (const [label, endpoint] of [
          ['token_endpoint', data.token_endpoint],
          ['registration_endpoint', data.registration_endpoint],
        ] as const) {
          if (!endpoint) continue;
          const endpointCheck = isUrlSafeToFetch(endpoint);
          if (!endpointCheck.safe) {
            onLog?.(`  ✗ Unsafe ${label} in metadata rejected`);
            return null;
          }
        }
        onLog?.('  ✓ Found OAuth metadata');
        return data;
      }
      onLog?.('  ✗ Invalid OAuth metadata (missing required fields)');
    } else {
      onLog?.(`  ✗ OAuth metadata endpoint returned ${response.status}`);
    }
  } catch {
    onLog?.('  ✗ OAuth metadata request failed');
  }
  return null;
}

/**
 * Protected resource metadata per RFC 9728
 */
interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

/** Default timeout for OAuth discovery requests (5 seconds) */
const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Check whether a dotted-quad IPv4 hostname falls in a private/reserved range.
 * Catches: 0.x, 10.x, 127.x, 172.16-31.x, 192.168.x, 169.254.x
 */
function isPrivateIPv4(hostname: string): boolean {
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipMatch) return false;
  const a = Number(ipMatch[1]);
  const b = Number(ipMatch[2]);
  return (
    a === 0 ||                             // 0.0.0.0/8
    a === 10 ||                            // 10.0.0.0/8
    a === 127 ||                           // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||   // 172.16.0.0/12
    (a === 192 && b === 168) ||            // 192.168.0.0/16
    (a === 169 && b === 254)               // 169.254.0.0/16 (link-local/AWS metadata)
  );
}

/**
 * Check whether an IPv6 hostname (already stripped of brackets, lowercase)
 * is loopback/private/link-local. WHATWG URL serializes IPv4-mapped
 * addresses as hex groups (`::ffff:7f00:1`), so both forms are handled.
 */
function isPrivateIPv6(v6: string): boolean {
  if (v6 === '::1' || v6 === '::') return true;           // loopback / unspecified
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 (ULA)
  if (/^fe[89ab]/.test(v6)) return true;                  // fe80::/10 (link-local)
  if (v6.startsWith('::ffff:')) {
    // IPv4-mapped — extract the embedded IPv4 and reuse the IPv4 check
    const tail = v6.slice('::ffff:'.length);
    if (tail.includes('.')) return isPrivateIPv4(tail);
    const groups = tail.split(':');
    if (groups.length > 2) return true; // malformed — be conservative
    const hi = parseInt(groups.length === 2 ? groups[0]! : '0', 16);
    const lo = parseInt(groups[groups.length - 1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
    const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(mapped);
  }
  return false;
}

/**
 * Check if a URL is safe to fetch (SSRF protection).
 * Rejects private IPs (v4 and v6), localhost, and non-HTTPS URLs.
 */
export function isUrlSafeToFetch(urlString: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Must be HTTPS (allow HTTP only for localhost in dev)
  if (url.protocol !== 'https:') {
    return { safe: false, reason: 'URL must use HTTPS' };
  }

  // Check hostname for private IP ranges
  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return { safe: false, reason: 'Localhost not allowed' };
  }

  // IPv6 — WHATWG URL keeps the brackets in url.hostname ('[::1]')
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    if (isPrivateIPv6(hostname.slice(1, -1))) {
      return { safe: false, reason: 'Private IPv6 range not allowed' };
    }
    return { safe: true };
  }

  if (isPrivateIPv4(hostname)) {
    return { safe: false, reason: 'Private IP range not allowed' };
  }

  return { safe: true };
}

/**
 * Type guard for ProtectedResourceMetadata
 */
function isProtectedResourceMetadata(data: unknown): data is ProtectedResourceMetadata {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  // resource is required
  if (typeof obj.resource !== 'string') return false;

  // authorization_servers is optional but must be string array if present
  if (obj.authorization_servers !== undefined) {
    if (!Array.isArray(obj.authorization_servers)) return false;
    if (!obj.authorization_servers.every(s => typeof s === 'string')) return false;
  }

  return true;
}

/** Max redirect hops followed by fetchWithTimeout (each hop is SSRF-validated) */
const MAX_OAUTH_REDIRECTS = 3;

/** Timeout for OAuth endpoint calls (token exchange, client registration) */
const OAUTH_ENDPOINT_TIMEOUT_MS = 30_000;

/**
 * Fetch with timeout using AbortController.
 *
 * SSRF protection: redirects are followed manually — each 3xx Location is
 * validated with isUrlSafeToFetch before being followed, so a public server
 * cannot redirect the request into a private/internal address.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_OAUTH_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Invalid redirect location from ${currentUrl}`);
    }

    const check = isUrlSafeToFetch(nextUrl);
    if (!check.safe) {
      throw new Error(`Redirect to unsafe URL blocked: ${check.reason}`);
    }
    currentUrl = nextUrl;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

/**
 * SSRF guard for OAuth endpoints that come from (potentially attacker
 * supplied) server metadata — token_endpoint / registration_endpoint must
 * never point at private/internal addresses.
 */
function assertSafeOAuthEndpoint(endpointUrl: string, label: string): void {
  const check = isUrlSafeToFetch(endpointUrl);
  if (!check.safe) {
    throw new Error(`Unsafe ${label} rejected: ${check.reason}`);
  }
}

/**
 * Normalize URL by removing trailing slash
 */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Parse the resource_metadata URL from a WWW-Authenticate header.
 * Example header: Bearer error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource/path"
 * Supports both double and single quoted values per RFC 7235.
 */
function parseResourceMetadataFromHeader(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;

  // Look for resource_metadata="..." or resource_metadata='...' in the header
  // Also handles optional spaces around the equals sign
  const match = wwwAuthenticate.match(/resource_metadata\s*=\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

/**
 * Fetch protected resource metadata and return the authorization server URL.
 * Per RFC 9728, the protected resource metadata contains authorization_servers array.
 */
async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  onLog?: (message: string) => void
): Promise<string | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = isUrlSafeToFetch(metadataUrl);
  if (!urlCheck.safe) {
    onLog?.(`  ✗ Unsafe URL rejected: ${urlCheck.reason}`);
    return null;
  }

  try {
    onLog?.(`  Fetching protected resource metadata...`);
    const response = await fetchWithTimeout(metadataUrl);
    if (!response.ok) {
      onLog?.(`  ✗ ${response.status} at metadata endpoint`);
      return null;
    }

    const data: unknown = await response.json();

    // Type guard validation
    if (!isProtectedResourceMetadata(data)) {
      onLog?.(`  ✗ Invalid protected resource metadata format`);
      return null;
    }

    // Check for non-empty authorization_servers array
    if (!data.authorization_servers?.length) {
      onLog?.(`  ✗ No authorization_servers in protected resource metadata`);
      return null;
    }

    const authServer = data.authorization_servers[0]!;

    // Validate the auth server URL too
    const authServerCheck = isUrlSafeToFetch(authServer);
    if (!authServerCheck.safe) {
      onLog?.(`  ✗ Unsafe authorization server URL rejected: ${authServerCheck.reason}`);
      return null;
    }

    onLog?.(`  ✓ Found authorization server`);
    return authServer;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onLog?.(`  ✗ Request timeout fetching protected resource metadata`);
    } else {
      onLog?.('  ✗ Protected resource metadata request failed');
    }
    return null;
  }
}

/**
 * Try to discover OAuth metadata via RFC 9728 flow:
 * 1. Make a request to the MCP endpoint to get 401 with WWW-Authenticate header
 * 2. Parse resource_metadata URL from the header
 * 3. Fetch protected resource metadata
 * 4. Get authorization server URL and fetch its metadata
 */
async function discoverViaProtectedResource(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying RFC 9728 protected resource discovery...`);

    // Make a request to the MCP endpoint to trigger 401
    // Try HEAD first, fall back to GET, then POST (Streamable HTTP servers only accept POST)
    let response: Response;
    try {
      response = await fetchWithTimeout(mcpUrl, { method: 'HEAD' });
      // Some servers don't support HEAD, fall back to GET
      if (response.status === 405) {
        onLog?.(`  HEAD not supported, trying GET...`);
        response = await fetchWithTimeout(mcpUrl, { method: 'GET' });
      }
      // Streamable HTTP MCP servers only accept POST.
      // POST is not a safe HTTP method, but this is acceptable here:
      // 1. We only proceed if the response is 401 (all other statuses are ignored)
      // 2. The endpoint is user-configured and trusted by design
      // 3. The body '{}' is a no-op for JSON-RPC servers (missing required fields)
      if (response.status === 405) {
        onLog?.(`  GET not supported, trying POST...`);
        response = await fetchWithTimeout(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        onLog?.(`  ✗ Request timeout`);
      }
      return null;
    }

    // We expect a 401 with WWW-Authenticate header
    if (response.status !== 401) {
      onLog?.(`  ✗ Expected 401, got ${response.status}`);
      return null;
    }

    const wwwAuth = response.headers.get('www-authenticate');
    const resourceMetadataUrl = parseResourceMetadataFromHeader(wwwAuth);

    if (!resourceMetadataUrl) {
      onLog?.(`  ✗ No resource_metadata in WWW-Authenticate header`);
      return null;
    }

    // SSRF protection: validate the resource_metadata URL
    const urlCheck = isUrlSafeToFetch(resourceMetadataUrl);
    if (!urlCheck.safe) {
      onLog?.(`  ✗ Unsafe resource_metadata URL rejected: ${urlCheck.reason}`);
      return null;
    }

    onLog?.(`  Found resource_metadata hint`);

    // Fetch protected resource metadata to get authorization server
    const authServerUrl = await fetchProtectedResourceMetadata(resourceMetadataUrl, onLog);
    if (!authServerUrl) {
      return null;
    }

    // Fetch authorization server metadata (normalize URL to avoid double slashes)
    const normalizedAuthServer = normalizeUrl(authServerUrl);
    const authServerMetadataUrl = `${normalizedAuthServer}/.well-known/oauth-authorization-server`;
    return await tryFetchAuthServerMetadata(authServerMetadataUrl, onLog);
  } catch {
    onLog?.('  ✗ RFC 9728 discovery failed');
    return null;
  }
}

/**
 * Discovers OAuth metadata using progressive discovery per RFC 8414 and RFC 9728.
 * Returns the first successful metadata, or null if all fail.
 *
 * Discovery order:
 * 1. RFC 9728: Parse resource_metadata from WWW-Authenticate header on 401
 * 2. Origin root: `{origin}/.well-known/oauth-authorization-server`
 * 3. Path-scoped: `{origin}/.well-known/oauth-authorization-server{pathname}`
 */
export async function discoverOAuthMetadata(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    onLog?.('Invalid MCP URL');
    return null;
  }

  // SSRF protection: never probe internal/private endpoints during discovery.
  // This covers the RFC 9728 probe of mcpUrl and the RFC 8414 candidates
  // derived from its origin.
  const mcpUrlCheck = isUrlSafeToFetch(mcpUrl);
  if (!mcpUrlCheck.safe) {
    onLog?.('Unsafe MCP URL rejected for OAuth discovery');
    return null;
  }

  onLog?.('Discovering OAuth metadata');

  // 1. Try RFC 9728 protected resource discovery first (handles Craft MCP and other compliant servers)
  const rfc9728Metadata = await discoverViaProtectedResource(mcpUrl, onLog);
  if (rfc9728Metadata) {
    return rfc9728Metadata;
  }

  // 2. Fall back to RFC 8414 discovery locations
  const candidates = [
    // Origin root (most common for MCP servers)
    `${url.origin}/.well-known/oauth-authorization-server`,
    // Path-scoped (RFC 8414 allows this)
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
  ];

  for (const candidate of candidates) {
    const candidateCheck = isUrlSafeToFetch(candidate);
    if (!candidateCheck.safe) {
      onLog?.('  ✗ Unsafe discovery URL rejected');
      continue;
    }
    const metadata = await tryFetchAuthServerMetadata(candidate, onLog);
    if (metadata) {
      return metadata;
    }
  }

  onLog?.('No OAuth metadata found');
  return null;
}
