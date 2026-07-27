import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_TOOL_DEFS,
  MCP_ONLY_TOOL_DEFS,
  getToolDefsAsJsonSchema,
  toJsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { CraftSessionToolsMcpServer } from '../packages/shared/src/mcp/session-tools-server.ts';

const errors: string[] = [];

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

const source = readFileSync('packages/session-tools-core/src/tool-defs.ts', 'utf-8');
process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = '1';
process.env.CRAFT_FEATURE_MEMORY = '1';

// ------------------------------------------------------------------
// 1. Canonical registry integrity.
//    SESSION_TOOL_DEFS is the native-and-mcp catalog; MCP_ONLY_TOOL_DEFS holds
//    the bridge-only tools. Both are declared through defineTool.
// ------------------------------------------------------------------
for (const def of SESSION_TOOL_DEFS) {
  assert(def.apiVersion === 'v1', `${def.name}: expected apiVersion v1`);
  assert(Boolean(def.inputSchema), `${def.name}: missing inputSchema`);
  assert(Boolean(def.outputSchema), `${def.name}: missing outputSchema`);
  assert(def.exposure === 'native-and-mcp', `${def.name}: SESSION_TOOL_DEFS must be native-and-mcp (got ${def.exposure})`);
}
for (const def of MCP_ONLY_TOOL_DEFS) {
  assert(def.apiVersion === 'v1', `${def.name}: expected apiVersion v1`);
  assert(Boolean(def.inputSchema), `${def.name}: missing inputSchema`);
  assert(Boolean(def.outputSchema), `${def.name}: missing outputSchema`);
  assert(def.exposure === 'mcp-only', `${def.name}: MCP_ONLY_TOOL_DEFS must carry exposure 'mcp-only' (got ${def.exposure})`);
  assert(def.executionMode === 'backend', `${def.name}: mcp-only tools must be backend-executed`);
}

// ------------------------------------------------------------------
// 2. Bypass detection — start from the UNREGISTERED set, not the registry.
//    Every handle* exported from packages/session-tools-core/src/handlers/*.ts
//    must be wired to exactly one defineTool entry. A handler exported but never
//    registered is a bypass: reachable code with no canonical tool, unroutable by
//    any backend. Enumerate the handler MODULES directly (glob) — handlers/index.ts
//    re-exports only a subset, so barrel iteration was blind to five handlers
//    (memory, messaging, send_agent_message), the list_background_tasks-style defect.
// ------------------------------------------------------------------
const handlerIdentToNames = new Map<string, string[]>();
const registeredToolNames = new Set<string>();
for (const rawLine of source.split('\n')) {
  const line = rawLine.trim();
  if (!line.startsWith('defineTool(')) continue;
  const nameMatch = line.match(/^defineTool\(\s*['"]([^'"]+)['"]/);
  if (!nameMatch) continue;
  const toolName = nameMatch[1]!;
  registeredToolNames.add(toolName);
  const handlerMatch = line.match(/handler:\s*([A-Za-z_$][\w$]*)/);
  if (!handlerMatch || handlerMatch[1] === 'null') continue;
  const list = handlerIdentToNames.get(handlerMatch[1]!) ?? [];
  list.push(toolName);
  handlerIdentToNames.set(handlerMatch[1]!, list);
}

for (const def of [...SESSION_TOOL_DEFS, ...MCP_ONLY_TOOL_DEFS]) {
  assert(registeredToolNames.has(def.name), `${def.name}: must be registered through defineTool in tool-defs.ts`);
}

// Enumerate every handle* export across the handler modules (glob), then require
// each to map to exactly one defineTool entry.
const HANDLERS_DIR = 'packages/session-tools-core/src/handlers';
const exportedHandlerNames = new Set<string>();
for (const file of readdirSync(HANDLERS_DIR)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'index.ts') continue;
  const handlerSource = readFileSync(join(HANDLERS_DIR, file), 'utf-8');
  for (const match of handlerSource.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(handle[A-Za-z0-9_$]*)/gm)) {
    exportedHandlerNames.add(match[1]!);
  }
}

for (const handlerName of exportedHandlerNames) {
  const registeredAs = handlerIdentToNames.get(handlerName) ?? [];
  assert(
    registeredAs.length === 1,
    registeredAs.length === 0
      ? `bypass: handler '${handlerName}' is exported from packages/session-tools-core/src/handlers but is not registered through defineTool — reachable code with no canonical tool, so no backend can route to it. Add a defineTool entry (or remove the handler).`
      : `handler '${handlerName}' is registered by more than one defineTool entry: ${registeredAs.join(', ')}`,
  );
}

// ------------------------------------------------------------------
// 3. Golden snapshot: the committed v1 contract (native ∪ mcp-only). Any drift
//    (schema, description, name set) fails until the golden is regenerated
//    explicitly — incompatible changes to a public v1 tool require a new major
//    version instead.
// ------------------------------------------------------------------
const nativeCatalog = getToolDefsAsJsonSchema({ includeDeveloperFeedback: true, includeMemory: true });
const mcpOnlyCatalog = MCP_ONLY_TOOL_DEFS.map((def) => toJsonSchemaToolDef(def));
const fullCatalog = [...nativeCatalog, ...mcpOnlyCatalog];
const canonicalByName = new Map(fullCatalog.map((tool) => [tool.name, tool]));

const GOLDEN_PATH = 'scripts/session-tool-contracts.golden.json';
const goldenCurrent = stableJson(Object.fromEntries(fullCatalog.map((tool) => [tool.name, tool])));
if (process.argv.includes('--update')) {
  writeFileSync(GOLDEN_PATH, `${goldenCurrent}\n`);
  console.log(`golden updated: ${GOLDEN_PATH} (${fullCatalog.length} tools)`);
} else if (!existsSync(GOLDEN_PATH)) {
  errors.push(`missing golden file ${GOLDEN_PATH} — generate it with: bun scripts/check-session-tool-contracts.ts --update`);
} else if (readFileSync(GOLDEN_PATH, 'utf-8').trim() !== goldenCurrent) {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, unknown>;
  const goldenNames = new Set(Object.keys(golden));
  const currentNames = new Set(fullCatalog.map((tool) => tool.name));
  for (const name of goldenNames) {
    if (!currentNames.has(name)) errors.push(`${name}: removed from catalog but present in golden`);
  }
  for (const tool of fullCatalog) {
    if (!goldenNames.has(tool.name)) {
      errors.push(`${tool.name}: new tool not in golden`);
    } else if (stableJson(golden[tool.name]) !== stableJson(tool)) {
      errors.push(`${tool.name}: contract differs from golden snapshot`);
    }
  }
  errors.push(
    `v1 session tool contracts drifted from ${GOLDEN_PATH}. ` +
    'Incompatible changes to a public v1 tool require a new major version; ' +
    'if this change is intentional and compatible, regenerate with: bun scripts/check-session-tool-contracts.ts --update',
  );
}

// ------------------------------------------------------------------
// 4. Backend listing parity, both directions. Every name reachable through the
//    Hermes MCP bridge must live in the canonical catalog (native ∪ mcp-only),
//    and every canonical tool must be reachable through the bridge. There is no
//    escape hatch: mcp-only tools are legitimate because they declare
//    exposure: 'mcp-only' in the canonical catalog, not a bridge-only flag.
// ------------------------------------------------------------------
const workspaceRootPath = mkdtempSync(join(tmpdir(), 'craft-session-tool-contracts-'));
const sessionId = 'contract-check-session';
mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true });

try {
  const bridge = new CraftSessionToolsMcpServer({
    sessionId,
    workspaceRootPath,
    workspaceId: 'contract-check',
  });
  const bridgeTools = bridge.getToolDefinitions();
  const bridgeByName = new Map(bridgeTools.map((tool) => [tool.name, tool]));

  // Direction 1: bridge ⊆ canonical, and each exposed tool's contract matches.
  for (const bridgeTool of bridgeTools) {
    const canonical = canonicalByName.get(bridgeTool.name);
    if (!canonical) {
      errors.push(`${bridgeTool.name}: bridge exposes a tool outside the canonical catalog (native ∪ mcp-only)`);
      continue;
    }
    assert(bridgeTool.description === canonical.description, `${bridgeTool.name}: description differs between bridge and canonical catalogs`);
    assert(stableJson(bridgeTool.inputSchema) === stableJson(canonical.inputSchema), `${bridgeTool.name}: input schema differs between bridge and canonical catalogs`);
    assert(stableJson(bridgeTool.outputSchema) === stableJson(canonical.outputSchema), `${bridgeTool.name}: output schema differs between bridge and canonical catalogs`);
    assert(bridgeTool._meta?.craftApiVersion === canonical.apiVersion, `${bridgeTool.name}: bridge metadata missing/incorrect api version`);
    assert(bridgeTool._meta?.craftExposure === canonical.exposure, `${bridgeTool.name}: bridge metadata missing/incorrect exposure`);
  }

  // Direction 2: canonical ⊆ bridge, except browser_tool (feature-gated in the bridge).
  for (const canonical of fullCatalog) {
    if (canonical.name === 'browser_tool') continue;
    assert(bridgeByName.has(canonical.name), `${canonical.name}: canonical catalog tool missing from the Hermes MCP bridge`);
  }
} finally {
  rmSync(workspaceRootPath, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`session tool contracts ok (${SESSION_TOOL_DEFS.length} native + ${MCP_ONLY_TOOL_DEFS.length} mcp-only tools)`);
