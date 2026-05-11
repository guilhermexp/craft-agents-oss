import { describe, expect, it } from 'bun:test';
import {
  CRAFT_AGENTS_DOCS_SOURCE_SLUG,
  classifyCraftBridgeEndpoint,
  createCraftBridgeChannelContext,
  getCraftDocumentContext,
  isCraftAgentsDocsSource,
  isCraftProductMcpSource,
  isCraftProductMcpEndpoint,
  sourceUsesCraftBridgeAuth,
  validateCraftProductMcpEndpoint,
} from '../index.ts';
import type { LoadedSource } from '../../sources/types.ts';

function source(overrides: Partial<LoadedSource['config']>): LoadedSource {
  return {
    workspaceId: 'workspace',
    workspaceRootPath: '/tmp/workspace',
    folderPath: '/tmp/workspace/sources/test',
    guide: null,
    config: {
      id: 'source',
      name: 'Source',
      slug: 'source',
      enabled: true,
      provider: 'generic',
      type: 'mcp',
      mcp: {
        transport: 'http',
        url: 'https://example.com/mcp',
        authType: 'oauth',
      },
      ...overrides,
    },
  };
}

describe('craft-bridge endpoint classification', () => {
  it('classifies Craft product MCP endpoints as craft-bridge owned', () => {
    const url = 'https://mcp.craft.do/links/ABC_123-x/mcp';

    expect(isCraftProductMcpEndpoint(url)).toBe(true);
    expect(classifyCraftBridgeEndpoint(url)).toEqual({
      kind: 'craft-product-mcp',
      capability: 'craft-bridge',
      url,
    });
    expect(validateCraftProductMcpEndpoint(url)).toEqual({ valid: true });
  });

  it('keeps non-Craft MCP endpoints generic', () => {
    const url = 'https://mcp.linear.app/sse';

    expect(isCraftProductMcpEndpoint(url)).toBe(false);
    expect(classifyCraftBridgeEndpoint(url)).toEqual({
      kind: 'generic-mcp',
      capability: 'generic-mcp',
      url,
    });
  });

  it('rejects Craft-shaped URLs with unsafe host or link id', () => {
    expect(validateCraftProductMcpEndpoint('https://mcp.craft.do.evil.com/links/abc/mcp')).toEqual({
      valid: false,
      error: 'Craft MCP URLs must use mcp.craft.do',
    });
    expect(validateCraftProductMcpEndpoint('https://mcp.craft.do/links/abc%20def/mcp')).toEqual({
      valid: false,
      error: 'Craft MCP link IDs may contain only letters, numbers, hyphens, and underscores',
    });
  });
});

describe('craft-bridge source contracts', () => {
  it('detects Craft product MCP sources without treating docs as user documents', () => {
    const craftSource = source({
      slug: 'craft-docs',
      provider: 'craft',
      mcp: {
        transport: 'http',
        url: 'https://mcp.craft.do/links/workspace_1/mcp',
        authType: 'oauth',
      },
      isAuthenticated: true,
    });
    const docsSource = source({
      slug: CRAFT_AGENTS_DOCS_SOURCE_SLUG,
      provider: 'mintlify',
      mcp: {
        transport: 'http',
        url: 'https://agents.craft.do/docs/mcp',
        authType: 'none',
      },
      isAuthenticated: true,
    });

    expect(isCraftProductMcpSource(craftSource)).toBe(true);
    expect(sourceUsesCraftBridgeAuth(craftSource)).toBe(true);
    expect(getCraftDocumentContext(craftSource)).toEqual({
      provider: 'craft-bridge',
      availability: 'available',
      sourceSlug: 'craft-docs',
    });
    expect(createCraftBridgeChannelContext(craftSource, 'Product documents')).toEqual({
      provider: 'craft-bridge',
      sourceSlug: 'craft-docs',
      description: 'Product documents',
    });

    expect(isCraftAgentsDocsSource(docsSource)).toBe(true);
    expect(isCraftProductMcpSource(docsSource)).toBe(false);
    expect(getCraftDocumentContext(docsSource)).toEqual({
      provider: 'craft-bridge',
      availability: 'unavailable',
      sourceSlug: CRAFT_AGENTS_DOCS_SOURCE_SLUG,
      reason: 'craft-agents-docs is public app documentation, not user Craft documents',
    });
  });

  it('keeps generic MCP OAuth outside craft-bridge', () => {
    const genericSource = source({
      slug: 'linear',
      provider: 'linear',
      mcp: {
        transport: 'http',
        url: 'https://mcp.linear.app/sse',
        authType: 'oauth',
      },
      isAuthenticated: true,
    });

    expect(isCraftProductMcpSource(genericSource)).toBe(false);
    expect(sourceUsesCraftBridgeAuth(genericSource)).toBe(false);
    expect(getCraftDocumentContext(genericSource)).toEqual({
      provider: 'craft-bridge',
      availability: 'unavailable',
      sourceSlug: 'linear',
      reason: 'Source is not a Craft product MCP endpoint',
    });
  });
});
