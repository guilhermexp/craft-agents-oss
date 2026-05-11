import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_TOOL_DEFS,
  getToolDefsAsJsonSchema,
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

for (const def of SESSION_TOOL_DEFS) {
  assert(def.apiVersion === 'v1', `${def.name}: expected apiVersion v1`);
  assert(Boolean(def.inputSchema), `${def.name}: missing inputSchema`);
  assert(Boolean(def.outputSchema), `${def.name}: missing outputSchema`);
  assert(def.exposure === 'native-and-mcp', `${def.name}: unexpected exposure ${def.exposure}`);
  assert(source.includes(`defineTool('${def.name}'`) || source.includes(`defineTool("${def.name}"`), `${def.name}: must be registered through defineTool`);
}

const nativeCatalog = getToolDefsAsJsonSchema({
  includeDeveloperFeedback: true,
  includeMemory: true,
});
const nativeByName = new Map(nativeCatalog.map((tool) => [tool.name, tool]));
const workspaceRootPath = mkdtempSync(join(tmpdir(), 'craft-session-tool-contracts-'));
const sessionId = 'contract-check-session';
mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true });

try {
  const bridge = new CraftSessionToolsMcpServer({
    sessionId,
    workspaceRootPath,
    workspaceId: 'contract-check',
  });
  const bridgeByName = new Map(bridge.getToolDefinitions().map((tool) => [tool.name, tool]));

  for (const nativeTool of nativeCatalog) {
    const bridgeTool = bridgeByName.get(nativeTool.name);
    if (!bridgeTool && nativeTool.name === 'browser_tool') {
      continue;
    }

    assert(Boolean(bridgeTool), `${nativeTool.name}: missing from Hermes ACP/MCP bridge catalog`);
    if (!bridgeTool) continue;

    assert(bridgeTool.description === nativeTool.description, `${nativeTool.name}: description differs between native and bridge catalogs`);
    assert(stableJson(bridgeTool.inputSchema) === stableJson(nativeTool.inputSchema), `${nativeTool.name}: input schema differs between native and bridge catalogs`);
    assert(stableJson(bridgeTool.outputSchema) === stableJson(nativeTool.outputSchema), `${nativeTool.name}: output schema differs between native and bridge catalogs`);
    assert(bridgeTool._meta?.craftApiVersion === nativeTool.apiVersion, `${nativeTool.name}: bridge metadata missing api version`);
  }

  for (const bridgeTool of bridgeByName.values()) {
    if (bridgeTool._meta?.craftBridgeOnly === true) {
      assert(Boolean(bridgeTool.outputSchema), `${bridgeTool.name}: bridge-only tool missing output schema`);
      assert(bridgeTool._meta.craftApiVersion === 'v1', `${bridgeTool.name}: bridge-only tool missing v1 metadata`);
      continue;
    }
    assert(nativeByName.has(bridgeTool.name), `${bridgeTool.name}: bridge exposes a tool outside the canonical native catalog`);
  }
} finally {
  rmSync(workspaceRootPath, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`session tool contracts ok (${SESSION_TOOL_DEFS.length} tools)`);
