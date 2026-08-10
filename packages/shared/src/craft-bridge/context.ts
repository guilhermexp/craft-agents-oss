import type { LoadedSource } from '../sources/types.ts';
import { isSourceUsable } from '../sources/storage.ts';
import { isCraftAgentsDocsSource, isCraftProductMcpSource } from './endpoint.ts';

export type CraftBridgeContextAvailability = 'available' | 'unavailable';

export interface CraftBridgeDocumentContext {
  provider: 'craft-bridge';
  availability: CraftBridgeContextAvailability;
  sourceSlug?: string;
  reason?: string;
}

export interface CraftBridgeChannelContext {
  provider: 'craft-bridge';
  sourceSlug: string;
  description?: string;
}

export function getCraftDocumentContext(source: LoadedSource | undefined): CraftBridgeDocumentContext {
  if (!source) {
    return {
      provider: 'craft-bridge',
      availability: 'unavailable',
      reason: 'No Craft product MCP source is enabled',
    };
  }

  if (isCraftAgentsDocsSource(source)) {
    return {
      provider: 'craft-bridge',
      availability: 'unavailable',
      sourceSlug: source.config.slug,
      reason: 'craft-agents-docs is public app documentation, not user Craft documents',
    };
  }

  if (!isCraftProductMcpSource(source)) {
    return {
      provider: 'craft-bridge',
      availability: 'unavailable',
      sourceSlug: source.config.slug,
      reason: 'Source is not a Craft product MCP endpoint',
    };
  }

  if (!isSourceUsable(source)) {
    return {
      provider: 'craft-bridge',
      availability: 'unavailable',
      sourceSlug: source.config.slug,
      reason: 'Craft product MCP source is not enabled and authenticated',
    };
  }

  return {
    provider: 'craft-bridge',
    availability: 'available',
    sourceSlug: source.config.slug,
  };
}

export function createCraftBridgeChannelContext(
  source: LoadedSource,
  description?: string,
): CraftBridgeChannelContext | undefined {
  const context = getCraftDocumentContext(source);
  if (context.availability !== 'available' || !context.sourceSlug) {
    return undefined;
  }

  return {
    provider: 'craft-bridge',
    sourceSlug: context.sourceSlug,
    description,
  };
}
