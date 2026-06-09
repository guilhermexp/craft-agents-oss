import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { LLMQueryRequest, LLMQueryResult } from '@craft-agent/shared/agent/llm-tool'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'

let capturedRequest: LLMQueryRequest | null = null

mock.module('../logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { mainLog: logger }
})

mock.module('@craft-agent/shared/config', () => ({
  getDefaultLlmConnection: () => 'claude-default',
  getLlmConnection: (slug: string) => ({ slug, providerType: 'anthropic' }),
  getLlmConnections: () => [{ slug: 'claude-default', providerType: 'anthropic' }],
}))

mock.module('@craft-agent/shared/skills', () => ({
  loadSkill: () => null,
}))

mock.module('@craft-agent/shared/agent/backend', () => ({
  createBackendFromConnection: () => ({
    async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
      capturedRequest = request
      return { text: '## Notes\n\n- Done' }
    },
    destroy: () => {},
  } as Pick<AgentBackend, 'queryLlm' | 'destroy'>),
}))

const { generateMeetingSummaryMarkdown } = await import('./meeting-summary-service')

beforeEach(() => {
  capturedRequest = null
})

describe('generateMeetingSummaryMarkdown', () => {
  it('adds follow-up extraction instructions when followUpOnEnd is enabled', async () => {
    const result = await generateMeetingSummaryMarkdown({
      workspaceId: 'ws-test',
      workspaceRootPath: '/tmp/workspace',
      record: {
        id: 'meeting-1',
        provider: 'google-meet',
        captureMode: 'craft',
        status: 'stopped',
        url: 'https://meet.google.com/abc-defg-hij',
        browserInstanceId: 'browser-1',
        title: 'Roadmap sync',
        startedAt: 1,
        updatedAt: 2,
        followUpOnEnd: true,
        summarizeOnEnd: true,
      },
      segments: [
        {
          id: 'seg-1',
          speaker: 'Speaker 1',
          text: 'Guilherme will ship the Deepgram-only follow-up fix tomorrow.',
          timestamp: 0,
        },
      ],
    })

    expect(result).toBe('## Notes\n\n- Done')
    expect(capturedRequest?.systemPrompt).toContain('follow-up')
    expect(capturedRequest?.systemPrompt).toContain('owners')
    expect(capturedRequest?.systemPrompt).toContain('due dates')
  })
})
