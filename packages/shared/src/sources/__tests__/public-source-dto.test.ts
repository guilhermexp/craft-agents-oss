import { describe, expect, test } from 'bun:test'

import {
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
  ])('removes explicit credentials from public URLs: %s', (url) => {
    const sanitized = sanitizePublicSourceUrl(url)
    expect(sanitized).toBeDefined()
    expect(sanitized).not.toContain('password')
    expect(sanitized).not.toContain('query-secret')
    expect(sanitized).not.toContain('fragment-secret')
    expect(sanitized).not.toContain('path-secret')
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
