import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { CraftOAuth, getMcpBaseUrl, discoverOAuthMetadata, prepareMcpOAuth, exchangeMcpOAuth, isUrlSafeToFetch } from '../oauth';

// ============================================================
// Unit tests for internal helpers exported only for testing
// We test them indirectly through discoverOAuthMetadata where needed,
// and directly by importing from the module's source for non-exported helpers
// ============================================================

describe('getMcpBaseUrl', () => {
  it('extracts origin from standard MCP URL', () => {
    expect(getMcpBaseUrl('https://example.com/mcp')).toBe('https://example.com');
  });

  it('extracts origin from double-path URL (Ahrefs case)', () => {
    expect(getMcpBaseUrl('https://api.ahrefs.com/mcp/mcp')).toBe('https://api.ahrefs.com');
  });

  it('extracts origin from URL with port', () => {
    expect(getMcpBaseUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000');
  });

  it('extracts origin from URL with deep path', () => {
    expect(getMcpBaseUrl('https://company.com/api/v2/mcp')).toBe('https://company.com');
  });

  it('extracts origin from URL with query params', () => {
    expect(getMcpBaseUrl('https://example.com/mcp?version=1')).toBe('https://example.com');
  });

  it('extracts origin from URL with trailing slash', () => {
    expect(getMcpBaseUrl('https://example.com/mcp/')).toBe('https://example.com');
  });

  it('extracts origin from SSE endpoint', () => {
    expect(getMcpBaseUrl('https://mcp.linear.app/sse')).toBe('https://mcp.linear.app');
  });

  it('extracts origin from GitHub Copilot MCP', () => {
    expect(getMcpBaseUrl('https://api.githubcopilot.com/mcp/')).toBe('https://api.githubcopilot.com');
  });

  it('returns as-is for invalid URL', () => {
    expect(getMcpBaseUrl('not-a-valid-url')).toBe('not-a-valid-url');
  });

  it('returns as-is for empty string', () => {
    expect(getMcpBaseUrl('')).toBe('');
  });
});

describe('discoverOAuthMetadata', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('RFC 9728 protected resource discovery', () => {
    it('discovers metadata via WWW-Authenticate resource_metadata hint', async () => {
      const protectedResourceMetadata = {
        resource: 'https://mcp.craft.do/my',
        authorization_servers: ['https://mcp.craft.do/my/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://mcp.craft.do/my/auth/authorize',
        token_endpoint: 'https://mcp.craft.do/my/auth/token',
        registration_endpoint: 'https://mcp.craft.do/my/auth/register',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request to MCP endpoint returns 401 with resource_metadata hint
        if (url === 'https://mcp.craft.do/my/mcp' && options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer error="invalid_token", resource_metadata="https://mcp.craft.do/.well-known/oauth-protected-resource/my"',
            },
          }));
        }
        // Protected resource metadata
        if (url === 'https://mcp.craft.do/.well-known/oauth-protected-resource/my') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        // Authorization server metadata
        if (url === 'https://mcp.craft.do/my/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://mcp.craft.do/my/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('falls back to RFC 8414 when HEAD returns non-401', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request returns 200 (no auth required or different auth)
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to RFC 8414 when no resource_metadata in header', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request returns 401 but without resource_metadata
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer error="invalid_token"',
            },
          }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back when protected resource metadata fetch fails', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        // Protected resource metadata returns 404
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response('Not Found', { status: 404 }));
        }
        // RFC 8414 fallback
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to GET when HEAD returns 405', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD returns 405 Method Not Allowed
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // GET returns 401 with resource_metadata
        if (url === 'https://example.com/mcp' && options?.method === 'GET') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('falls back to POST when both HEAD and GET return 405 (Streamable HTTP)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD returns 405
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // GET also returns 405 (Streamable HTTP servers only accept POST)
        if (url === 'https://example.com/mcp' && options?.method === 'GET') {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        // POST returns 401 with resource_metadata
        if (url === 'https://example.com/mcp' && options?.method === 'POST') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('falls back when authorization_servers is empty array', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: [], // Empty array
      };

      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back when protected resource returns malformed JSON', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response('not valid json {{{', { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('rejects resource_metadata URL pointing to private IP (SSRF protection)', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Malicious server tries to redirect to AWS metadata endpoint
              'WWW-Authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data/"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Should fall back to RFC 8414 instead of following SSRF URL
      expect(result).toEqual(metadata);
    });

    it('rejects resource_metadata URL with non-HTTPS scheme', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="http://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('handles trailing slash in authorization server URL', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth/'], // Trailing slash
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        // Should be normalized to single slash
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('parses resource_metadata with single quotes', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Single quotes instead of double quotes
              'WWW-Authenticate': "Bearer resource_metadata='https://example.com/.well-known/oauth-protected-resource'",
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });
  });

  describe('RFC 8414 discovery fallback', () => {
    it('discovers metadata at origin root', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails (no RFC 9728 support)
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

    it('falls back to path-scoped discovery', async () => {
      const metadata = {
        authorization_endpoint: 'https://api.ahrefs.com/oauth/authorize',
        token_endpoint: 'https://api.ahrefs.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://api.ahrefs.com/.well-known/oauth-authorization-server/mcp/mcp') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://api.ahrefs.com/mcp/mcp');
      expect(result).toEqual(metadata);
    });
  });

  describe('SSRF protection on mcpUrl (discovery entry point)', () => {
    it('rejects link-local metadata endpoint without any fetch', async () => {
      const result = await discoverOAuthMetadata('https://169.254.169.254/mcp');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects localhost without any fetch', async () => {
      const result = await discoverOAuthMetadata('https://localhost/mcp');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects private IP ranges without any fetch', async () => {
      for (const url of ['https://10.0.0.5/mcp', 'https://192.168.1.1/mcp', 'https://172.16.0.1/mcp']) {
        const result = await discoverOAuthMetadata(url);
        expect(result).toBeNull();
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects non-HTTPS mcpUrl without any fetch', async () => {
      const result = await discoverOAuthMetadata('http://example.com/mcp');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns null when no metadata found', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

    it('returns null for invalid URL', async () => {
      const result = await discoverOAuthMetadata('not-a-valid-url');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null when metadata is missing required fields', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ some: 'data' }), { status: 200 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

    it('handles network errors gracefully', async () => {
      const logs: string[] = [];
      mockFetch.mockImplementation(() => {
        return Promise.reject(new Error('Network error token=network-secret client_secret=client-secret'));
      });

      const result = await discoverOAuthMetadata(
        'https://user:password@example.com/mcp?session_token=url-secret',
        (message) => logs.push(message),
      );
      expect(result).toBeNull();
      const evidence = logs.join('\n');
      for (const secret of ['network-secret', 'client-secret', 'user:password', 'url-secret']) {
        expect(evidence).not.toContain(secret);
      }
    });
  });

  it('keeps CraftOAuth status callbacks and thrown failures free of provider details', async () => {
    const statuses: string[] = [];
    mockFetch.mockRejectedValue(new Error(
      'token=provider-secret client_secret=client-secret Authorization: Bearer auth-secret',
    ));
    const oauth = new CraftOAuth(
      { mcpUrl: 'https://user:password@example.com/mcp?session_token=url-secret' },
      { onStatus: (message) => statuses.push(message), onError: (message) => statuses.push(message) },
    );

    let thrown = '';
    try {
      await oauth.authenticate();
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toBe('oauth-metadata-unavailable');
    const evidence = `${statuses.join('\n')}\n${thrown}`;
    for (const secret of ['provider-secret', 'client-secret', 'auth-secret', 'user:password', 'url-secret']) {
      expect(evidence).not.toContain(secret);
    }
  });

  it('calls onLog callback with discovery progress', async () => {
    const logs: string[] = [];
    const onLog = (msg: string) => logs.push(msg);

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await discoverOAuthMetadata('https://example.com/mcp', onLog);

    expect(logs.some(l => l.includes('Discovering OAuth metadata'))).toBe(true);
    expect(logs.some(l => l.includes('RFC 9728'))).toBe(true);
    expect(logs.some(l => l.includes('No OAuth metadata found'))).toBe(true);
  });

  it('includes registration_endpoint when present', async () => {
    const metadata = {
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      registration_endpoint: 'https://example.com/oauth/register',
    };

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result?.registration_endpoint).toBe('https://example.com/oauth/register');
  });

  // ============================================================
  // SSRF Protection – isUrlSafeToFetch (tested via discoverOAuthMetadata)
  // ============================================================
  describe('SSRF protection via isUrlSafeToFetch', () => {
    // Helper: set up a 401 with resource_metadata pointing at the given URL
    function setupSsrfTest(resourceMetadataUrl: string) {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

    it('rejects IPv6 loopback ::1', async () => {
      const fallback = setupSsrfTest('https://[::1]/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 0.0.0.0', async () => {
      const fallback = setupSsrfTest('https://0.0.0.0/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 10.x.x.x private range', async () => {
      const fallback = setupSsrfTest('https://10.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 172.16.x.x private range', async () => {
      const fallback = setupSsrfTest('https://172.16.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 172.31.x.x private range (upper bound)', async () => {
      const fallback = setupSsrfTest('https://172.31.255.255/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 192.168.x.x private range', async () => {
      const fallback = setupSsrfTest('https://192.168.1.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects 127.0.0.1 loopback', async () => {
      const fallback = setupSsrfTest('https://127.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects localhost', async () => {
      const fallback = setupSsrfTest('https://localhost/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects link-local 169.254.x.x (AWS metadata)', async () => {
      const fallback = setupSsrfTest('https://169.254.169.254/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects HTTP scheme (non-HTTPS)', async () => {
      const fallback = setupSsrfTest('http://safe-domain.com/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('rejects authorization_servers pointing to private IP', async () => {
      // The protected resource metadata itself is safe, but the auth server points to a private IP
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://10.0.0.1/auth'],
      };

      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Should fall back because auth server URL is unsafe
      expect(result).toEqual(fallbackMetadata);
    });
  });

  // ============================================================
  // WWW-Authenticate header parsing edge cases
  // ============================================================
  describe('WWW-Authenticate header parsing edge cases', () => {
    it('handles resource_metadata with extra spaces around equals sign', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Extra spaces around =
              'WWW-Authenticate': 'Bearer resource_metadata  =  "https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('falls back when WWW-Authenticate header is null', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          // 401 but no WWW-Authenticate header
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('handles multiple WWW-Authenticate challenges (resource_metadata among other params)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Multiple params before and after resource_metadata
              'WWW-Authenticate': 'Bearer realm="example", error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource", error_description="expired"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('falls back when resource_metadata value has no quotes', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // No quotes around the value
              'WWW-Authenticate': 'Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Without quotes, parseResourceMetadataFromHeader returns null, so falls back
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back when WWW-Authenticate is empty string', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': '' },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });
  });

  // ============================================================
  // Protected resource metadata validation edge cases
  // ============================================================
  describe('protected resource metadata validation', () => {
    // Helper to set up 401 flow leading to a resource metadata response
    function setup401WithResourceMetadata(resourceMetadataBody: unknown) {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(
            JSON.stringify(resourceMetadataBody), { status: 200 }
          ));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

    it('falls back when resource metadata is null', async () => {
      const fallback = setup401WithResourceMetadata(null);
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when resource metadata is a string', async () => {
      const fallback = setup401WithResourceMetadata('not an object');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when resource metadata is missing "resource" field', async () => {
      const fallback = setup401WithResourceMetadata({
        authorization_servers: ['https://example.com/auth'],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when authorization_servers contains non-string items', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: [123, true],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('falls back when authorization_servers is not an array', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: 'not an array',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

    it('succeeds when authorization_servers is absent but uses fallback', async () => {
      // resource metadata with no authorization_servers field at all
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });
  });

  // ============================================================
  // Timeout handling
  // ============================================================
  describe('timeout handling', () => {
    it('falls back when HEAD request times out (AbortError)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // Simulate abort on HEAD and GET for the MCP endpoint
        if (url === 'https://example.com/mcp') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back when protected resource metadata fetch times out', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        // Timeout on protected resource metadata
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('logs timeout message on AbortError for protected resource metadata', async () => {
      const logs: string[] = [];
      const onLog = (msg: string) => logs.push(msg);

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      await discoverOAuthMetadata('https://example.com/mcp', onLog);
      expect(logs.some(l => l.includes('timeout'))).toBe(true);
    });
  });

  // ============================================================
  // normalizeUrl behavior (tested via trailing slash in auth server)
  // ============================================================
  describe('URL normalization', () => {
    it('handles authorization server URL without trailing slash', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'], // No trailing slash
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

    it('handles authorization server URL at root (no path)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://auth.example.com'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });
  });

  // ============================================================
  // HEAD returning other status codes
  // ============================================================
  describe('HEAD returning various non-401 status codes', () => {
    it('falls back on HEAD 403 (Forbidden)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back on HEAD 500 (Internal Server Error)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

    it('falls back on HEAD 301 (redirect)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 301 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });
  });
});

describe('prepareMcpOAuth', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('falls back to the default client ID when registration is forbidden', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('craft-agent');
    expect(result.clientSecret).toBeUndefined();
    expect(result.authUrl).toContain('client_id=craft-agent');
    expect(result.provider).toBe('mcp');
  });

  it('keeps the dynamically registered client when registration succeeds', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response(JSON.stringify({
          client_id: 'dynamic-client',
          client_secret: 'secret-123',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('dynamic-client');
    expect(result.clientSecret).toBe('secret-123');
    expect(result.authUrl).toContain('client_id=dynamic-client');
  });

  it('throws on unexpected registration failures instead of silently falling back', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Server error', { status: 500 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await expect(prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 })).rejects.toThrow('oauth-client-registration-failed');
  });
});

// ============================================================
// F7/R2 — isUrlSafeToFetch: IPv6 loopback/private/link-local
// ============================================================
describe('isUrlSafeToFetch IPv6 (R2)', () => {
  it('rejects bracketed IPv6 loopback [::1]', () => {
    expect(isUrlSafeToFetch('https://[::1]/').safe).toBe(false);
  });

  it('rejects IPv6 unspecified [::]', () => {
    expect(isUrlSafeToFetch('https://[::]/').safe).toBe(false);
  });

  it('rejects IPv6 link-local fe80::/10', () => {
    expect(isUrlSafeToFetch('https://[fe80::1]/').safe).toBe(false);
    expect(isUrlSafeToFetch('https://[febf::1]/').safe).toBe(false);
  });

  it('rejects IPv6 ULA fc00::/7', () => {
    expect(isUrlSafeToFetch('https://[fc00::1]/').safe).toBe(false);
    expect(isUrlSafeToFetch('https://[fd12:3456::1]/').safe).toBe(false);
  });

  it('rejects IPv4-mapped private addresses in both forms', () => {
    // WHATWG URL serializes ::ffff:127.0.0.1 to hex groups — cover both
    expect(isUrlSafeToFetch('https://[::ffff:127.0.0.1]/').safe).toBe(false);
    expect(isUrlSafeToFetch('https://[::ffff:7f00:1]/').safe).toBe(false);
    expect(isUrlSafeToFetch('https://[::ffff:169.254.169.254]/').safe).toBe(false);
  });

  it('allows public IPv6 addresses', () => {
    expect(isUrlSafeToFetch('https://[2606:4700::1111]/').safe).toBe(true);
  });

  it('allows IPv4-mapped public addresses', () => {
    expect(isUrlSafeToFetch('https://[::ffff:1.1.1.1]/').safe).toBe(true);
  });
});

// ============================================================
// F7/R3 — SSRF: metadata endpoints validated + redirect re-validation
// ============================================================
describe('OAuth endpoint/redirect SSRF (R3)', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('exchangeMcpOAuth rejects internal token endpoint before any fetch', async () => {
    const result = await exchangeMcpOAuth({
      tokenEndpoint: 'https://127.0.0.1/token',
      code: 'code',
      codeVerifier: 'verifier',
      clientId: 'client',
      redirectUri: 'http://localhost:1234/callback',
    } as Parameters<typeof exchangeMcpOAuth>[0]);

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      error: 'OAuth token exchange failed',
      errorCode: 'oauth-token-exchange-failed',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exchangeMcpOAuth rejects bracketed IPv6 loopback token endpoint', async () => {
    const result = await exchangeMcpOAuth({
      tokenEndpoint: 'https://[::1]/token',
      code: 'code',
      codeVerifier: 'verifier',
      clientId: 'client',
      redirectUri: 'http://localhost:1234/callback',
    } as Parameters<typeof exchangeMcpOAuth>[0]);

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('discovery rejects metadata whose token_endpoint is internal', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://127.0.0.1/token',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result).toBeNull();
    // The internal token endpoint must never be fetched
    const fetchedUrls = mockFetch.mock.calls.map((call: any[]) => call[0]);
    expect(fetchedUrls).not.toContain('https://127.0.0.1/token');
  });

  it('discovery rejects metadata whose registration_endpoint is internal', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://[::1]/register',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result).toBeNull();
  });

  it('blocks 302 redirect to an internal Location during discovery', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data' },
        }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result).toBeNull();
    const fetchedUrls = mockFetch.mock.calls.map((call: any[]) => call[0]);
    expect(fetchedUrls).not.toContain('https://169.254.169.254/latest/meta-data');
  });

  it('follows 302 redirect to a public https Location', async () => {
    const metadata = {
      authorization_endpoint: 'https://sso.example.com/oauth/authorize',
      token_endpoint: 'https://sso.example.com/oauth/token',
    };
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: 'https://sso.example.com/.well-known/oauth-authorization-server' },
        }));
      }
      if (url === 'https://sso.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result).toEqual(metadata);
  });
});
