export type MemoryCategory = 'profile' | 'event' | 'knowledge' | 'behavior' | 'skill';

export type MemoryTarget = 'agent' | 'user';

export type DisclosureLevel = 'compact' | 'timeline' | 'full';

export interface Memory {
  id: string;
  target: MemoryTarget;
  category: MemoryCategory;
  content: string;
  contentHash: string;
  tags: string[];
  refIds: string[];
  reinforcementCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchOptions {
  query: string;
  target?: MemoryTarget;
  category?: MemoryCategory;
  tags?: string[];
  limit?: number;
  minSalience?: number;
}

export interface MemorySearchResult {
  memory: Memory;
  salienceScore: number;
  matchType: 'fts' | 'vector' | 'hybrid';
}

export interface MemoryContext {
  level: DisclosureLevel;
  tokenEstimate: number;
  content: string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}

export interface MemoryConfig {
  enabled: boolean;
  dbPath: string;
  embeddingProvider: 'anthropic' | 'openai' | 'local' | 'none';
  salienceHalfLifeDays: number;
  maxCompactTokens: number;
  maxTimelineTokens: number;
  maxFullTokens: number;
  autoObserve: boolean;
  contextWindow: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  dbPath: '',
  embeddingProvider: 'none',
  salienceHalfLifeDays: 30,
  maxCompactTokens: 50,
  maxTimelineTokens: 200,
  maxFullTokens: 1000,
  autoObserve: true,
  contextWindow: 200_000,
};

export interface ToolUseRecord {
  name: string;
  input: unknown;
  output: unknown;
}

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'profile', 'event', 'knowledge', 'behavior', 'skill',
] as const;

export const MEMORY_TARGETS: readonly MemoryTarget[] = ['agent', 'user'] as const;

export const HALF_LIFE_BY_CATEGORY: Record<MemoryCategory, number> = {
  profile: 180,
  knowledge: 60,
  behavior: 90,
  skill: 120,
  event: 14,
};

export const RETENTION_DAYS: Record<MemoryCategory, number> = {
  profile: Infinity,
  knowledge: 365,
  behavior: 180,
  skill: 365,
  event: 90,
};
