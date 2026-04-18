import type { MemoryCategory } from './types.ts';
import { HALF_LIFE_BY_CATEGORY } from './types.ts';

export function computeSalience(params: {
  similarity: number;
  reinforcementCount: number;
  daysSinceLastAccess: number;
  category: MemoryCategory;
}): number {
  const { similarity, reinforcementCount, daysSinceLastAccess, category } = params;
  const halfLife = HALF_LIFE_BY_CATEGORY[category];

  const raw = similarity
    * Math.log(reinforcementCount + 1)
    * Math.exp(-0.693 * daysSinceLastAccess / halfLife);

  return Math.max(0, Math.min(1, raw));
}

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / (1000 * 60 * 60 * 24));
}
