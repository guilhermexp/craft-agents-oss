import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { enableDebug } from '../../utils/debug.ts';
import * as storage from '../storage.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import type { LoadedSource } from '../types.ts';

const originalStderrWrite = process.stderr.write.bind(process.stderr);
const activeSpies: Array<{ mockRestore(): void }> = [];
const privateFailure = 'token=log-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';

function source(): LoadedSource {
  return {
    config: {
      id: 'source-id', name: 'Source', slug: 'source', enabled: true, provider: 'custom', type: 'api',
      api: { baseUrl: 'https://example.test', authType: 'header', headerNames: ['X-Key'] },
    },
    guide: null,
    folderPath: '/tmp/workspace/sources/source',
    workspaceRootPath: '/tmp/workspace',
    workspaceId: 'workspace',
  };
}

function captureLogs(): string[] {
  const logs: string[] = [];
  enableDebug();
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return logs;
}

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  while (activeSpies.length > 0) activeSpies.pop()?.mockRestore();
});

describe('SourceCredentialManager debug redaction', () => {
  test('does not log JSON parse error details', async () => {
    const manager = new SourceCredentialManager();
    activeSpies.push(spyOn(manager, 'load').mockResolvedValue({ value: `{"X-Key":"${privateFailure}` }));
    const logs = captureLogs();

    await manager.getApiCredential(source());

    expect(logs.join('')).toContain('JSON parse failed');
    expect(logs.join('')).not.toContain('arbitrary-provider-text');
  });

  test('does not log caught config persistence errors', () => {
    activeSpies.push(spyOn(storage, 'loadSourceConfig').mockImplementation(() => { throw new Error(privateFailure); }));
    const logs = captureLogs();

    new SourceCredentialManager().markSourceNeedsReauth(source(), 'Token refresh failed');

    expect(logs.join('')).toContain('Failed to mark source as needing re-auth');
    expect(logs.join('')).not.toContain('arbitrary-provider-text');
  });
});
