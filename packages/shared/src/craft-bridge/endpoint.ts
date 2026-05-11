import type { LoadedSource } from '../sources/types.ts';

export const CRAFT_PRODUCT_MCP_HOST = 'mcp.craft.do';
export const CRAFT_PRODUCT_MCP_PATH_PREFIX = '/links/';
export const CRAFT_AGENTS_DOCS_MCP_URL = 'https://agents.craft.do/docs/mcp';
export const CRAFT_AGENTS_DOCS_SOURCE_SLUG = 'craft-agents-docs';

export type CraftBridgeEndpointKind = 'craft-product-mcp' | 'craft-agents-docs' | 'generic-mcp';

export interface CraftBridgeEndpointClassification {
  kind: CraftBridgeEndpointKind;
  capability: 'craft-bridge' | 'generic-mcp' | 'craft-agents-docs';
  url: string;
}

export interface CraftBridgeUrlValidationResult {
  valid: boolean;
  error?: string;
}

export function classifyCraftBridgeEndpoint(url: string): CraftBridgeEndpointClassification {
  if (url === CRAFT_AGENTS_DOCS_MCP_URL) {
    return { kind: 'craft-agents-docs', capability: 'craft-agents-docs', url };
  }

  return isCraftProductMcpEndpoint(url)
    ? { kind: 'craft-product-mcp', capability: 'craft-bridge', url }
    : { kind: 'generic-mcp', capability: 'generic-mcp', url };
}

export function isCraftProductMcpEndpoint(url: string | undefined): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === CRAFT_PRODUCT_MCP_HOST
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname.startsWith(CRAFT_PRODUCT_MCP_PATH_PREFIX)
      && parsed.pathname.endsWith('/mcp')
      && parsed.pathname.split('/').length === 4
      && isValidCraftLinkId(parsed.pathname.split('/')[2]);
  } catch {
    return false;
  }
}

export function validateCraftProductMcpEndpoint(url: string): CraftBridgeUrlValidationResult {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Craft MCP URLs must use https://' };
    }
    if (parsed.hostname !== CRAFT_PRODUCT_MCP_HOST) {
      return { valid: false, error: 'Craft MCP URLs must use mcp.craft.do' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, error: 'Craft MCP URLs must not include credentials' };
    }
    if (!parsed.pathname.startsWith(CRAFT_PRODUCT_MCP_PATH_PREFIX)) {
      return { valid: false, error: 'Craft MCP URLs must use the /links/{id}/mcp path' };
    }
    const parts = parsed.pathname.split('/');
    if (parts.length !== 4 || parts[1] !== 'links' || parts[3] !== 'mcp') {
      return { valid: false, error: 'Craft MCP URLs must match https://mcp.craft.do/links/{id}/mcp' };
    }
    if (!isValidCraftLinkId(parts[2])) {
      return { valid: false, error: 'Craft MCP link IDs may contain only letters, numbers, hyphens, and underscores' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Craft MCP URL must be a syntactically valid URL' };
  }
}

export function isCraftAgentsDocsEndpoint(url: string | undefined): boolean {
  return url === CRAFT_AGENTS_DOCS_MCP_URL;
}

export function isCraftAgentsDocsSource(source: LoadedSource): boolean {
  return source.config.slug === CRAFT_AGENTS_DOCS_SOURCE_SLUG
    || isCraftAgentsDocsEndpoint(source.config.mcp?.url);
}

export function isCraftProductMcpSource(source: LoadedSource): boolean {
  return source.config.type === 'mcp'
    && !isCraftAgentsDocsSource(source)
    && isCraftProductMcpEndpoint(source.config.mcp?.url);
}

function isValidCraftLinkId(value: string | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}
