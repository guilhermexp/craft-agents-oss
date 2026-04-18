import type { Memory, MemoryCategory, MemoryTarget, ToolUseRecord } from './types.ts';
import type { MemoryStore } from './memory-store.ts';
import { sanitizeMemoryContent } from './sanitizer.ts';

type QueryFn = (prompt: string) => Promise<string | null>;

interface TurnParams {
  sessionId: string;
  turnId: string;
  userMessage: string;
  assistantResponse: string;
  toolUses?: ToolUseRecord[];
}

interface ExtractedMemory {
  target: MemoryTarget;
  category: MemoryCategory;
  content: string;
  tags: string[];
}

export class ObservationPipeline {
  constructor(
    private store: MemoryStore,
    private queryFn?: QueryFn,
  ) {}

  async processAssistantTurn(params: TurnParams): Promise<Memory[]> {
    if (this.store.hasTurnBeenProcessed(params.turnId)) return [];

    if (!this.queryFn) return [];

    try {
      const extracted = await Promise.race([
        this.extractMemories(params),
        this.timeout(10_000),
      ]);

      this.store.markTurnProcessed(params.turnId);
      return extracted;
    } catch {
      this.store.markTurnProcessed(params.turnId);
      return [];
    }
  }

  private async extractMemories(params: TurnParams): Promise<Memory[]> {
    const prompt = this.buildExtractionPrompt(params.userMessage, params.assistantResponse, params.toolUses);
    const response = await this.queryFn!(prompt);

    if (!response) return [];

    const parsed = this.parseExtractedMemories(response);
    const memories: Memory[] = [];

    for (const item of parsed) {
      const sanitizeResult = sanitizeMemoryContent(item.content);
      if (!sanitizeResult.safe) continue;

      try {
        const { memory } = await this.store.upsert({
          target: item.target,
          category: item.category,
          content: item.content,
          tags: item.tags,
          sourceSessionId: params.sessionId,
        });
        memories.push(memory);
      } catch {
        // skip failed upserts
      }
    }

    return memories;
  }

  buildExtractionPrompt(
    userMessage: string,
    assistantResponse: string,
    toolUses?: ToolUseRecord[],
  ): string {
    const toolContext = toolUses?.length
      ? `\nTools used: ${toolUses.map(t => t.name).join(', ')}`
      : '';

    return `Extract durable facts from this conversation turn. Only extract information that will be useful in future sessions.

User: ${userMessage.substring(0, 500)}
Assistant: ${assistantResponse.substring(0, 500)}${toolContext}

Return a JSON array of memories to save. Each item must have:
- "target": "user" (about the user) or "agent" (about the environment/project)
- "category": one of "profile", "event", "knowledge", "behavior", "skill"
- "content": the fact to remember (concise, 1-2 sentences)
- "tags": array of relevant tags

Rules:
- Only save durable facts, not task progress or session state
- Prefer user preferences and corrections over environment facts
- Skip trivial or easily re-discoverable information
- Return [] if nothing worth saving

Response (JSON array only):`;
  }

  parseExtractedMemories(response: string): ExtractedMemory[] {
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (item: unknown): item is ExtractedMemory =>
          typeof item === 'object' &&
          item !== null &&
          'target' in item &&
          'category' in item &&
          'content' in item &&
          typeof (item as ExtractedMemory).content === 'string' &&
          ['user', 'agent'].includes((item as ExtractedMemory).target) &&
          ['profile', 'event', 'knowledge', 'behavior', 'skill'].includes((item as ExtractedMemory).category),
      ).map((item: ExtractedMemory) => ({
        ...item,
        tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
      }));
    } catch {
      return [];
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Extraction timeout')), ms),
    );
  }
}
