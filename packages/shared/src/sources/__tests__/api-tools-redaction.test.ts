import { afterEach, describe, expect, mock, test } from 'bun:test';
import { enableDebug } from '../../utils/debug.ts';
import { createApiTool } from '../api-tools.ts';
import type { ApiConfig } from '../types.ts';

interface MinimalTool {
  handler(args: Record<string, unknown>): Promise<unknown>;
}

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const privateFailure = 'token=api-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';

function config(): ApiConfig {
  return {
    name: 'redaction-test',
    baseUrl: 'https://user:pass@example.test/private?credential=url-secret',
    auth: { type: 'bearer', authScheme: 'Bearer' },
  };
}

function captureDebugLogs(): { logs: string[]; restore(): void } {
  const logs: string[] = [];
  enableDebug();
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    logs,
    restore: () => { process.stderr.write = originalStderrWrite; },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
});

describe('createApiTool public errors and logs', () => {
  test('does not log URL, headers, body, or return an upstream error body', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(privateFailure, { status: 401 }))) as unknown as typeof fetch;
    const capture = captureDebugLogs();
    try {
      const apiTool = createApiTool(config(), 'api-secret') as unknown as MinimalTool;

      const result = await apiTool.handler({
        path: `/endpoint?token=path-secret`,
        method: 'POST',
        params: { _rawBody: `${privateFailure} raw-body-secret`, _contentType: 'text/plain' },
      });
      const evidence = JSON.stringify({ result, logs: capture.logs });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'API request failed (status 401)' }],
        isError: true,
      });
      expect(evidence).toContain('POST request');
      expect(evidence).toContain('status 401');
      expect(evidence).toContain('bodyLength=');
      for (const secret of ['api-secret', 'client-secret', 'auth-secret', 'user:pass', 'url-secret', 'path-secret', 'raw-body-secret', 'arbitrary-provider-text']) {
        expect(evidence).not.toContain(secret);
      }
      expect(evidence).not.toContain('headers=');
      expect(evidence).not.toContain('example.test');
    } finally {
      capture.restore();
    }
  });

  test('returns and logs only a stable code for caught request errors', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error(privateFailure))) as unknown as typeof fetch;
    const capture = captureDebugLogs();
    try {
      const apiTool = createApiTool(config(), 'api-secret') as unknown as MinimalTool;

      const result = await apiTool.handler({ path: '/endpoint', method: 'GET' });
      const evidence = JSON.stringify({ result, logs: capture.logs });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'API request failed' }],
        isError: true,
      });
      expect(evidence).toContain('[api-tools] redaction-test request failed');
      expect(evidence).not.toContain('arbitrary-provider-text');
      expect(evidence).not.toContain('example.test');
    } finally {
      capture.restore();
    }
  });
});
