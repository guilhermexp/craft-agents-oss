import { describe, expect, test } from 'bun:test'

import {
  sanitizePublicSourceError,
  sanitizePublicSourceUrl,
  toPublicSourceDto,
  toPublicSourceDtos,
} from '../public-source-dto'
import { SOURCE_CONNECTION_STATUSES, type LoadedSource } from '../types'

function sourceWithUrl(url: string): LoadedSource {
  return {
    config: {
      id: 'source-id',
      name: 'Source',
      slug: 'source',
      enabled: true,
      provider: 'provider',
      type: 'mcp',
      mcp: { transport: 'http', url },
    },
    guide: null,
    folderPath: '/workspace/sources/source',
    workspaceRootPath: '/workspace',
    workspaceId: 'workspace',
  }
}

describe('public source DTO boundary', () => {
  test('uses one exhaustive connection-status contract including source_test persisted states', () => {
    expect(SOURCE_CONNECTION_STATUSES).toEqual([
      'connected',
      'needs_auth',
      'failed',
      'untested',
      'local_disabled',
      'unhealthy',
      'disconnected',
      'error',
      'unknown',
    ])
  })

  test('copies only the explicit config allowlist when future fields carry sentinels', () => {
    const source = sourceWithUrl('https://mcp.example.test/source')
    Object.assign(source.config, {
      futureCredential: 'future-config-secret',
      credentialParams: { apiKey: 'nested-secret' },
    })

    const payload = JSON.stringify(toPublicSourceDto(source))

    expect(payload).not.toContain('future-config-secret')
    expect(payload).not.toContain('nested-secret')
    expect(payload).not.toContain('futureCredential')
  })

  test('does not spread future local config fields across the public boundary', () => {
    const source = sourceWithUrl('https://mcp.example.test/source')
    source.config.mcp = undefined
    source.config.local = {
      path: '/workspace/public',
      format: 'filesystem',
      futureCredential: 'future-local-secret',
    } as typeof source.config.local

    const payload = JSON.stringify(toPublicSourceDto(source))

    expect(payload).not.toContain('future-local-secret')
    expect(payload).not.toContain('futureCredential')
  })

  test('does not spread future brand or tool-identity fields', () => {
    const source = sourceWithUrl('https://mcp.example.test/source')
    source.config.brand = {
      color: 'accent',
      futureCredential: 'future-brand-secret',
    } as typeof source.config.brand
    source.config.expectedTools = [{
      name: 'issues_list',
      apiVersion: 'v1',
      futureCredential: 'future-tool-secret',
    } as NonNullable<typeof source.config.expectedTools>[number]]

    const payload = JSON.stringify(toPublicSourceDto(source))

    expect(payload).not.toContain('future-brand-secret')
    expect(payload).not.toContain('future-tool-secret')
  })

  test('redacts every source in a changed-event collection', () => {
    const source = sourceWithUrl('https://mcp.example.test/source')
    Object.assign(source.config.mcp!, {
      headers: { Authorization: 'Bearer changed-event-secret' },
    })

    const payload = JSON.stringify(toPublicSourceDtos([source]))

    expect(payload).not.toContain('changed-event-secret')
    expect(payload).not.toContain('Authorization')
  })

  test.each([
    'https://user:password@mcp.example.test/source',
    'https://mcp.example.test/source?api-key=query-secret&safe=value',
    'https://mcp.example.test/source?X-Amz-Signature=query-secret',
    'https://mcp.example.test/source?X-Amz-Security-Token=query-secret',
    'https://mcp.example.test/source#credential=fragment-secret',
    'https://mcp.example.test/source#safe=value&token=nested-fragment-secret',
    'https://mcp.example.test/token/path-secret',
    'https://mcp.example.test/clientSecret/path-secret',
    'https://mcp.example.test/source?client_secret=query-secret',
    'https://mcp.example.test/source?privateKey=query-secret',
    'https://mcp.example.test/source?consumer-secret=query-secret',
    'https://mcp.example.test/source?signature=query-secret',
    'https://mcp.example.test/source#securityToken=fragment-secret',
    'https://mcp.example.test/source?signed-url=query-secret',
    'https://mcp.example.test/source?id_token=query-secret',
    'https://mcp.example.test/source?idToken=query-secret',
    'https://mcp.example.test/source?id-token=query-secret',
    'https://mcp.example.test/source?session_token=query-secret',
    'https://mcp.example.test/source?sessionToken=query-secret',
    'https://mcp.example.test/source?session-token=query-secret',
    'https://mcp.example.test/source?oauth_token_secret=query-secret',
    'https://mcp.example.test/source?oauthTokenSecret=query-secret',
    'https://mcp.example.test/source?oauth-token-secret=query-secret',
    'https://mcp.example.test/source?aws_secret_access_key=query-secret',
    'https://mcp.example.test/source?awsSecretAccessKey=query-secret',
    'https://mcp.example.test/source?aws-secret-access-key=query-secret',
    'https://mcp.example.test/source?oauth_token=query-secret',
    'https://mcp.example.test/source?access_key_id=query-secret',
    'https://mcp.example.test/source?secret_access_key=query-secret',
    'https://mcp.example.test/source?aws_access_key_id=query-secret',
    'https://mcp.example.test/source?aws_session_token=query-secret',
    'https://mcp.example.test/source?oauth_consumer_secret=query-secret',
  ])('removes explicit credentials from public URLs: %s', (url) => {
    const sanitized = sanitizePublicSourceUrl(url)
    expect(sanitized).toBeDefined()
    expect(sanitized).not.toContain('password')
    expect(sanitized).not.toContain('query-secret')
    expect(sanitized).not.toContain('fragment-secret')
    expect(sanitized).not.toContain('path-secret')
  })

  test.each([
    ['{"password":"alpha beta"}', '{"password":"[REDACTED]"}'],
    ['{"access_token" : "json secret with spaces"}', '{"access_token" : "[REDACTED]"}'],
    ['{password: alpha beta, safe: visible}', '{password: [REDACTED], safe: visible}'],
    ['\\{"access_token":\\"escaped-secret\\"}', '\\{"access_token":\\"[REDACTED]\\"}'],
    ['\\{\\"access_token\\":\\"fully-escaped-secret\\"}', '\\{\\"access_token\\":\\"[REDACTED]\\"}'],
    [String.raw`\{\"password\":\"alpha\\\"beta-secret\"}`, String.raw`\{\"password\":\"[REDACTED]\"}`],
    ['Authorization: Bearer auth value with spaces', 'Authorization: Bearer [REDACTED]'],
  ])('redacts the complete public-text credential value in %s', (input, expected) => {
    expect(sanitizePublicSourceError(input)).toBe(expected)
  })

  test('sanitizes credential-bearing JSON-escaped URLs embedded in public text', () => {
    expect(sanitizePublicSourceError(
      String.raw`Guide https:\/\/user:password@example.test/privateKey/path-secret`,
    )).toBe('Guide https://example.test/privateKey/[REDACTED]')
  })

  test('uses the same normalized secret-name classifier in text and URLs', () => {
    const text = [
      'client_secret=client secret value',
      'clientSecret=camel secret value',
      'private-key=private key value',
      'consumerSecret=consumer secret value',
      'signature=signature value',
      'security_token=security token value',
      'signedUrl=signed url value',
      'id_token=id token value',
      'sessionToken=session token value',
      'oauth-token-secret=oauth token secret value',
      'aws_secret_access_key=aws secret access key value',
      'oauth_token=oauth token value',
      'access-key-id=access key id value',
      'secretAccessKey=secret access key value',
      'aws_access_key_id=aws access key id value',
      'aws-session-token=aws session token value',
      'oauthConsumerSecret=oauth consumer secret value',
    ].join('; ')

    const sanitized = sanitizePublicSourceError(text)
    for (const sentinel of [
      'client secret value',
      'camel secret value',
      'private key value',
      'consumer secret value',
      'signature value',
      'security token value',
      'signed url value',
      'id token value',
      'session token value',
      'oauth token secret value',
      'aws secret access key value',
      'oauth token value',
      'access key id value',
      'secret access key value',
      'aws access key id value',
      'aws session token value',
      'oauth consumer secret value',
    ]) {
      expect(sanitized).not.toContain(sentinel)
    }
  })

  test('redacts vendor-prefixed credential headers', () => {
    // Regression: an exact-match name allowlist let every prefixed header
    // through into the public DTO, which SOURCES_GET serves to the renderer
    // and to remote webui clients.
    const text = [
      'x-api-key=alpha leak',
      'X-Api-Key: bravo leak',
      '{"headers":{"X-Auth-Token":"charlie leak"}}',
      'Private-Token: delta leak',
      '{"X-Access-Token":"echo leak"}',
      'x-goog-api-key=foxtrot leak',
    ].join('; ')

    const sanitized = sanitizePublicSourceError(text)

    for (const sentinel of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) {
      expect(sanitized).not.toContain(sentinel)
    }
  })

  test('leaves non-credential names that merely embed a secret word intact', () => {
    // Suffix-anchored word matching, not containment: `monkey` ends in "key"
    // and `tokenCount` starts with "token", but neither is a credential.
    const sanitized = sanitizePublicSourceError(
      'monkey=visible; keyword=visible; tokenCount=42; sessionId=visible; keyboardLayout=us',
    )

    expect(sanitized).toBe(
      'monkey=visible; keyword=visible; tokenCount=42; sessionId=visible; keyboardLayout=us',
    )
  })

  test('redacts quoted JSON credentials and credential-bearing URLs from every public text field', () => {
    const source = sourceWithUrl('https://mcp.example.test/source')
    source.config.name = 'Name https://example.test/name?token=name-secret'
    source.config.provider = 'Provider https://example.test/provider#token=provider-secret'
    source.config.tagline = 'Open https://example.test/callback?token=tagline-secret'
    source.config.connectionError = '{"access_token":"json-secret","Authorization":"Bearer auth-secret"}'
    source.guide = {
      raw: 'Docs https://example.test/docs?X-Amz-Security-Token=guide-secret',
      context: 'Context https://example.test/context#token=context-secret',
    }

    const payload = JSON.stringify(toPublicSourceDto(source))

    for (const sentinel of [
      'tagline-secret',
      'json-secret',
      'auth-secret',
      'guide-secret',
      'context-secret',
      'name-secret',
      'provider-secret',
    ]) {
      expect(payload).not.toContain(sentinel)
    }
  })

  test('preserves an ordinary Composio UUID path in the public DTO', () => {
    const url = 'https://mcp.composio.dev/550e8400-e29b-41d4-a716-446655440000/mcp'
    expect(toPublicSourceDto(sourceWithUrl(url)).config.mcp?.url).toBe(url)
  })
})
