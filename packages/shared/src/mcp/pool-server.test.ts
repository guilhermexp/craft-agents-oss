import { afterEach, describe, expect, it } from 'bun:test';

import { McpPoolServer } from './pool-server.ts';
import type { McpClientPool } from './mcp-pool.ts';

const stubPool = {
  getProxyToolDefs: () => [
    { name: 'mcp__craft__search_spaces', description: 'stub', inputSchema: { type: 'object' } },
  ],
  callTool: async () => ({ content: 'ok', isError: false }),
} as unknown as McpClientPool;

// Raw JSON-RPC initialize POST — the pool server runs the Streamable HTTP
// transport in stateless mode, so a single POST is the representative request.
function initializePost(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'pool-test', version: '0.0.1' },
      },
    }),
  });
}

describe('McpPoolServer', () => {
  let server: McpPoolServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('accepts loopback MCP requests without an Origin header', async () => {
    server = new McpPoolServer(stubPool);
    const url = await server.start();

    const res = await initializePost(url);
    expect(res.status).toBe(200);
  });

  it('rejects requests with a non-loopback web Origin', async () => {
    server = new McpPoolServer(stubPool);
    const url = await server.start();

    const res = await initializePost(url, { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('enforces opt-in bearer auth when authToken is configured', async () => {
    server = new McpPoolServer(stubPool, { authToken: 'pool-secret' });
    const url = await server.start();

    const noToken = await initializePost(url);
    expect(noToken.status).toBe(401);

    const wrongToken = await initializePost(url, { authorization: 'Bearer wrong' });
    expect(wrongToken.status).toBe(401);

    const withToken = await initializePost(url, { authorization: 'Bearer pool-secret' });
    expect(withToken.status).toBe(200);
  });
});
