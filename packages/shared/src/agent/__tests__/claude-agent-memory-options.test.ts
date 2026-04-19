import { describe, expect, it } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';
import type { ClaudeAgentConfig } from '../claude-agent.ts';

function createConfig(): ClaudeAgentConfig {
  return {
    workspace: {
      id: 'test-workspace',
      name: 'Test Workspace',
      slug: 'test-workspace',
      rootPath: '/tmp/test-workspace',
      createdAt: Date.now(),
    },
    session: {
      id: 'test-session',
      name: 'Test Session',
      workspaceRootPath: '/tmp/test-workspace',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    model: 'claude-sonnet-4-5',
    miniModel: 'claude-haiku-3-5',
    isHeadless: true,
  };
}

describe('ClaudeAgent memory session tool options', () => {
  class TestClaudeAgent extends ClaudeAgent {
    getSessionToolOptions() {
      return this.getSessionToolOptionsForCurrentAgent();
    }

    setMemoryStoreForTest(memoryStore: unknown): void {
      this.memoryStore = memoryStore as any;
    }
  }

  it('returns memoryStore in the session tool options when memory is initialized', () => {
    const agent = new TestClaudeAgent(createConfig());
    const memoryStore = { searchHybrid: () => [] } as any;

    agent.setMemoryStoreForTest(memoryStore);

    expect(agent.getSessionToolOptions()?.memoryStore).toBe(memoryStore);
  });

  it('returns undefined when memory is not initialized', () => {
    const agent = new TestClaudeAgent(createConfig());

    expect(agent.getSessionToolOptions()).toBeUndefined();
  });
});
