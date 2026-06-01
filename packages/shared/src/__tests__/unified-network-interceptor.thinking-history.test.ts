import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

// Regression coverage for the extended-thinking history guard.
//
// When an assistant turn carries `thinking`/`redacted_thinking` content blocks,
// the Anthropic API treats that turn as cryptographically signed and rejects ANY
// modification with a 400 ("`thinking` ... blocks in the latest assistant message
// cannot be modified"). The history metadata re-injection must therefore skip such
// turns instead of mutating a sibling `tool_use.input`.

let anthropicAdapter: typeof import('../unified-network-interceptor.ts').anthropicAdapter;
let toolMetadataStore: typeof import('../interceptor-common.ts').toolMetadataStore;

const seededIds: string[] = [];

beforeAll(async () => {
  process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
  ({ anthropicAdapter } = await import('../unified-network-interceptor.ts'));
  ({ toolMetadataStore } = await import('../interceptor-common.ts'));
});

afterEach(() => {
  for (const id of seededIds.splice(0)) toolMetadataStore.delete(id);
});

function seed(id: string): void {
  toolMetadataStore.set(id, { intent: 'do the thing', displayName: 'Do Thing', timestamp: 1 });
  seededIds.push(id);
}

describe('anthropicAdapter.injectMetadataIntoHistory — extended thinking guard', () => {
  it('does NOT mutate tool_use blocks in an assistant turn that contains a thinking block', () => {
    seed('tool-signed');
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning…', signature: 'sig-abc' },
            { type: 'tool_use', id: 'tool-signed', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      ],
    };

    anthropicAdapter.injectMetadataIntoHistory(body);

    const toolUse = body.messages[0]!.content[1] as { input: Record<string, unknown> };
    expect('_intent' in toolUse.input).toBe(false);
    expect('_displayName' in toolUse.input).toBe(false);
    expect(toolUse.input).toEqual({ command: 'ls' });
  });

  it('skips an assistant turn with a redacted_thinking block', () => {
    seed('tool-redacted');
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'tool_use', id: 'tool-redacted', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      ],
    };

    anthropicAdapter.injectMetadataIntoHistory(body);

    const toolUse = body.messages[0]!.content[1] as { input: Record<string, unknown> };
    expect('_intent' in toolUse.input).toBe(false);
    expect(toolUse.input).toEqual({ command: 'pwd' });
  });

  it('still injects metadata into a non-thinking assistant turn (baseline preserved)', () => {
    seed('tool-plain');
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-plain', name: 'Bash', input: { command: 'ls' } }],
        },
      ],
    };

    anthropicAdapter.injectMetadataIntoHistory(body);

    const toolUse = body.messages[0]!.content[0] as { input: Record<string, unknown> };
    expect(toolUse.input._intent).toBe('do the thing');
    expect(toolUse.input._displayName).toBe('Do Thing');
    expect(toolUse.input.command).toBe('ls');
  });
});
