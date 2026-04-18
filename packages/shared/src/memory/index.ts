export { MemoryStore } from './memory-store.ts';
export { MemoryContextBuilder } from './memory-context-builder.ts';
export { ObservationPipeline } from './observation-pipeline.ts';
export { computeSalience, daysBetween } from './salience.ts';
export { computeContentHash, normalizeContent } from './deduplication.ts';
export { sanitizeMemoryContent, stripMemoryFenceTags } from './sanitizer.ts';
export { createEmbeddingProvider, NoopEmbeddingProvider } from './embedding-provider.ts';
export { getInitSQL, CURRENT_SCHEMA_VERSION } from './schema.ts';

export type {
  Memory,
  MemoryCategory,
  MemoryTarget,
  MemoryConfig,
  MemoryContext,
  MemorySearchOptions,
  MemorySearchResult,
  DisclosureLevel,
  EmbeddingProvider,
  ToolUseRecord,
} from './types.ts';

export {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_CATEGORIES,
  MEMORY_TARGETS,
  HALF_LIFE_BY_CATEGORY,
  RETENTION_DAYS,
} from './types.ts';
