# Memory Service

Persistent cross-session memory for AI agents. Stores durable facts about users and projects that survive across sessions, enabling personalized and context-aware interactions.

## Feature Flag

Disabled by default. Enable with:

```bash
CRAFT_FEATURE_MEMORY=1
```

Or set `memoryEnabled: true` in workspace config.

## Storage

- Database: `~/.craft-agent/memory.db` (SQLite with WAL mode)
- Format: SQLite with FTS5 full-text search indexes

## Architecture

```
packages/shared/src/memory/
├── types.ts                    # Interfaces, enums, constants
├── schema.ts                   # SQLite DDL + migrations
├── sanitizer.ts                # Anti-prompt-injection (blocks threats before storage)
├── deduplication.ts            # SHA-256 content hash + normalization
├── salience.ts                 # Relevance scoring with recency decay
├── memory-store.ts             # Core CRUD, FTS5 search, maintenance
├── memory-context-builder.ts   # Progressive disclosure (compact/timeline/full)
├── observation-pipeline.ts     # Post-turn LLM extraction (auto-observe)
├── embedding-provider.ts       # Pluggable vector embeddings (optional)
└── index.ts                    # Public exports
```

## Memory Targets

| Target | Purpose | Examples |
|--------|---------|---------|
| `user` | Who the user is | Name, role, preferences, communication style |
| `agent` | Agent's notes | Environment facts, project conventions, tool quirks |

## Memory Categories

| Category | Half-life | Retention | Description |
|----------|-----------|-----------|-------------|
| `profile` | 180 days | Forever | User preferences, identity, style |
| `knowledge` | 60 days | 1 year | Project facts, architecture decisions |
| `behavior` | 90 days | 180 days | Workflow patterns, recurring actions |
| `skill` | 120 days | 1 year | Procedures, learned techniques |
| `event` | 14 days | 90 days | Meetings, incidents, deadlines |

Half-life controls how quickly a memory's relevance decays. Retention is the maximum age before automatic cleanup.

## Tools

### `memory_store`

Save, replace, or remove memories.

```json
{
  "action": "add",
  "target": "user",
  "category": "profile",
  "content": "User prefers dark mode and TypeScript",
  "tags": ["preferences", "editor"]
}
```

Actions:
- `add` — Create new entry (deduplicates automatically via content hash)
- `replace` — Find entry by `old_text` substring, replace with `content`
- `remove` — Find entry by `old_text` substring, delete it

### `memory_recall`

Search memories by query, ranked by salience score.

```json
{
  "query": "TypeScript preferences",
  "target": "user",
  "category": "profile",
  "limit": 10
}
```

Returns memories sorted by salience (relevance x reinforcement x recency).

## Salience Scoring

Memories are ranked by a composite score:

```
salience = similarity × log(reinforcement + 1) × exp(-0.693 × days / half_life)
```

| Factor | Effect |
|--------|--------|
| `similarity` | FTS5 rank normalized to 0-1 |
| `reinforcement` | Logarithmic boost for frequently-seen facts |
| `recency` | Exponential decay based on category half-life |

Score is clamped to [0, 1]. Higher = more relevant.

## Progressive Disclosure

Memory context injected into the system prompt adapts to available token budget:

| Level | Budget | Content |
|-------|--------|---------|
| `compact` | < 80 tokens | Entry counts and category summary |
| `timeline` | < 300 tokens | Top 10 memories by salience with previews |
| `full` | 300+ tokens | Detailed memories grouped by target/category |

Budget = min(5% of context window, 1000 tokens). Automatically chosen per turn.

## Deduplication

Content is hashed with SHA-256 after normalization (lowercase, trim, collapse whitespace). The hash is scoped by target — same content for `user` and `agent` creates two entries.

When a duplicate is inserted, the existing entry is reinforced (count +1) instead of creating a new row.

## Security

### Sanitizer

All content is scanned before storage for:

- **Prompt injection** — "ignore previous instructions", role hijacking
- **Exfiltration** — curl/wget with secret variables, reading credential files
- **Invisible unicode** — Zero-width characters used for injection

Blocked content returns an error and is never stored.

### Fence Tags

Memory content injected into the system prompt is wrapped in `<memory-context>` tags. The content is stripped of any fence tag sequences (`</memory-context>`) to prevent premature tag closure and prompt injection.

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `memories` | Core entries with content, hash, timestamps, reinforcement count |
| `memory_tags` | Many-to-many tags per memory (indexed for fast filtering) |
| `memory_refs` | Cross-references between memories |
| `memories_fts` | FTS5 virtual table for full-text search |
| `memory_embeddings` | Optional vector embeddings (BLOB storage) |
| `processed_turns` | Idempotency tracking for observation pipeline |
| `schema_version` | Migration versioning |

### Indexes

- `(target)` — Filter by user/agent
- `(category)` — Filter by memory type
- `(content_hash)` — Fast dedup lookups
- `(target, category, updated_at)` — Compound index for scaled queries

## Maintenance

### Automatic cleanup

On `MemoryStore.initialize()`:
- Removes expired memories (based on category retention) with reinforcement count ≤ 1

### Manual pruning

```typescript
store.pruneAndArchive(0.01); // Remove memories with salience < 0.01
store.vacuum();              // Reclaim disk space
```

## Integration Points

| Component | File | Integration |
|-----------|------|-------------|
| Feature flag | `feature-flags.ts` | `FEATURE_FLAGS.memory` / `isMemoryEnabled()` |
| PromptBuilder | `agent/core/prompt-builder.ts` | Injects `<memory-context>` block |
| BaseAgent | `agent/base-agent.ts` | Initializes MemoryStore + ContextBuilder |
| Session tools | `session-scoped-tools.ts` | Passes `includeMemory` flag + injects callbacks |
| System prompt | `prompts/system.ts` | Conditional memory instructions block |
| Tool handlers | `session-tools-core/src/handlers/` | `memory-store.ts`, `memory-recall.ts` |
| Context wiring | `claude-context.ts` | `injectMemoryCallbacks()` bridges store → tools |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `CRAFT_FEATURE_MEMORY` | `0` | Enable/disable memory service |
| `embeddingProvider` | `none` | Vector embedding provider (none/anthropic/openai) |
| `autoObserve` | `true` | Auto-extract memories from turns |

## Extending

### Adding a new category

1. Add to `MemoryCategory` type in `types.ts`
2. Add half-life in `HALF_LIFE_BY_CATEGORY`
3. Add retention in `RETENTION_DAYS`
4. Update the CHECK constraint in `schema.ts` (requires migration)

### Adding an embedding provider

Implement the `EmbeddingProvider` interface:

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}
```

Register in `createEmbeddingProvider()` in `embedding-provider.ts`.
