import { describe, expect, it } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getToolDefsAsJsonSchema,
  validateSessionToolOutput,
} from '@craft-agent/session-tools-core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/index.js';

describe('workspace_objects MCP transport schema', () => {
  it('validates structuredContent instead of the internal ToolResult envelope', () => {
    const transportDef = getToolDefsAsJsonSchema({ includeWorkspaceObjects: true })
      .find(def => def.name === 'workspace_objects');
    const canonicalDef = SESSION_TOOL_DEFS.find(def => def.name === 'workspace_objects');
    expect(transportDef).toBeDefined();
    expect(canonicalDef).toBeDefined();
    if (!transportDef || !canonicalDef) return;

    const structuredContent = {
      objectId: 'object_people',
      revision: 1,
      projectionStatus: 'ready',
    };
    const validateTransportOutput = new AjvJsonSchemaValidator()
      .getValidator<Record<string, unknown>>(transportDef.outputSchema as JsonSchemaType);

    expect(validateTransportOutput(structuredContent)).toMatchObject({ valid: true });
    expect(transportDef.outputSchema.required).toBeUndefined();
    expect(validateSessionToolOutput(canonicalDef, {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    })).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    });
  });
});
