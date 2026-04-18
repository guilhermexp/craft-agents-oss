import type { MemoryContext, MemoryCategory, DisclosureLevel } from './types.ts';
import type { MemoryStore } from './memory-store.ts';
import { computeSalience, daysBetween } from './salience.ts';
import { stripMemoryFenceTags } from './sanitizer.ts';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n...[truncated]';
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  profile: 'Profile',
  event: 'Events',
  knowledge: 'Knowledge',
  behavior: 'Behavior',
  skill: 'Skills',
};

export class MemoryContextBuilder {
  constructor(
    private store: MemoryStore,
  ) {}

  buildContext(options: {
    availableTokens: number;
    query?: string;
  }): MemoryContext {
    const budget = Math.min(Math.floor(options.availableTokens * 0.05), 1000);

    let level: DisclosureLevel;
    if (budget < 80) {
      level = 'compact';
    } else if (budget < 300) {
      level = 'timeline';
    } else {
      level = 'full';
    }

    let content: string;
    switch (level) {
      case 'compact':
        content = truncateToTokenBudget(stripMemoryFenceTags(this.buildCompactIndex()), budget);
        break;
      case 'timeline':
        content = truncateToTokenBudget(stripMemoryFenceTags(this.buildTimeline()), budget);
        break;
      case 'full':
        content = truncateToTokenBudget(stripMemoryFenceTags(this.buildFullDetails(options.query)), budget);
        break;
    }

    return {
      level,
      tokenEstimate: estimateTokens(content),
      content,
    };
  }

  buildCompactIndex(): string {
    const counts = this.store.count();
    if (counts.total === 0) return '';

    const parts: string[] = [];
    parts.push(`Memory: ${counts.total} entries (${counts.user} user, ${counts.agent} agent)`);

    const userMemories = this.store.getByTarget('user');
    if (userMemories.length > 0) {
      const categories = new Set(userMemories.map(m => m.category));
      parts.push(`User profile: ${Array.from(categories).join(', ')}`);
    }

    return parts.join('. ') + '.';
  }

  buildTimeline(): string {
    const now = Date.now();
    const all = this.store.getAll();
    if (all.length === 0) return '';

    const scored = all.map(m => ({
      memory: m,
      salience: computeSalience({
        similarity: 1,
        reinforcementCount: m.reinforcementCount,
        daysSinceLastAccess: daysBetween(m.lastAccessedAt, now),
        category: m.category,
      }),
    }))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 10);

    const lines: string[] = ['Recent memories (by relevance):'];
    for (const { memory, salience } of scored) {
      const age = Math.floor(daysBetween(memory.createdAt, now));
      const ageLabel = age === 0 ? 'today' : `${age}d ago`;
      const preview = memory.content.length > 80
        ? memory.content.substring(0, 80) + '...'
        : memory.content;
      lines.push(`- [${CATEGORY_LABELS[memory.category]}] ${preview} (${ageLabel}, score: ${salience.toFixed(2)})`);
    }

    return lines.join('\n');
  }

  buildFullDetails(query?: string): string {
    if (query) {
      const results = this.store.searchHybrid({ query, limit: 10 });
      if (results.length === 0) return this.buildTimeline();

      const lines: string[] = ['Relevant memories:'];
      for (const { memory, salienceScore } of results) {
        lines.push(`\n### ${CATEGORY_LABELS[memory.category]} (${memory.target}) [score: ${salienceScore.toFixed(2)}]`);
        lines.push(memory.content);
        if (memory.tags.length > 0) {
          lines.push(`Tags: ${memory.tags.join(', ')}`);
        }
      }
      return lines.join('\n');
    }

    const userMemories = this.store.getByTarget('user');
    const agentMemories = this.store.getByTarget('agent');

    const lines: string[] = [];

    if (userMemories.length > 0) {
      lines.push('## User Profile');
      const byCategory = groupByCategory(userMemories);
      for (const [cat, memories] of Object.entries(byCategory)) {
        lines.push(`\n### ${CATEGORY_LABELS[cat as MemoryCategory]}`);
        for (const m of memories.slice(0, 5)) {
          lines.push(`- ${m.content}`);
        }
      }
    }

    if (agentMemories.length > 0) {
      lines.push('\n## Agent Notes');
      const byCategory = groupByCategory(agentMemories);
      for (const [cat, memories] of Object.entries(byCategory)) {
        lines.push(`\n### ${CATEGORY_LABELS[cat as MemoryCategory]}`);
        for (const m of memories.slice(0, 5)) {
          lines.push(`- ${m.content}`);
        }
      }
    }

    return lines.join('\n') || this.buildTimeline();
  }
}

function groupByCategory(memories: Array<{ category: MemoryCategory; content: string }>): Record<string, typeof memories> {
  const groups: Record<string, typeof memories> = {};
  for (const m of memories) {
    if (!groups[m.category]) groups[m.category] = [];
    groups[m.category]!.push(m);
  }
  return groups;
}
