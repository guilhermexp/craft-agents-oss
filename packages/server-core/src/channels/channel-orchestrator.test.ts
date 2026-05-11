import { describe, expect, it } from 'bun:test';
import { createChannelOrchestrator, type ChannelAgentRuntime } from './channel-orchestrator.ts';
import type { WarRoomChannel } from '@craft-agent/shared/channels';

function createRuntime(): ChannelAgentRuntime & {
  created: Array<Parameters<ChannelAgentRuntime['createSession']>[0]>;
  sent: Array<Parameters<ChannelAgentRuntime['sendMessage']>[0]>;
} {
  let next = 1;
  const created: Array<Parameters<ChannelAgentRuntime['createSession']>[0]> = [];
  const sent: Array<Parameters<ChannelAgentRuntime['sendMessage']>[0]> = [];
  return {
    created,
    sent,
    async createSession(input) {
      created.push(input);
      return { id: `session-${next++}` };
    },
    async sendMessage(input) {
      sent.push(input);
      return { assistantText: `response from ${input.sessionId}` };
    },
  };
}

const channel: WarRoomChannel = {
  id: 'architecture',
  name: 'Architecture',
  labelId: 'channel-architecture',
  participants: [
    {
      id: 'hermes-lead',
      displayName: 'Hermes Lead',
      llmConnection: 'hermes',
      hermesProfile: 'lead',
      defaultSourceSlugs: ['docs'],
      permissionMode: 'ask',
    },
    {
      id: 'pi-reviewer',
      displayName: 'Pi Reviewer',
      llmConnection: 'pi-copilot',
      model: 'auto',
    },
  ],
};

describe('ChannelOrchestrator', () => {
  it('creates one backing session per mentioned participant and labels it with the channel label', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    const result = await orchestrator.sendMessage({
      channel,
      text: '@hermes-lead @pi-reviewer revisem o plano',
      authorId: 'human',
    });

    expect(result.targetedParticipantIds).toEqual(['hermes-lead', 'pi-reviewer']);
    expect(runtime.created).toEqual([
      {
        name: 'Architecture / Hermes Lead',
        labels: ['channel-architecture'],
        llmConnection: 'hermes',
        model: undefined,
        hermesProfile: 'lead',
        enabledSourceSlugs: ['docs'],
        permissionMode: 'ask',
        workingDirectory: undefined,
      },
      {
        name: 'Architecture / Pi Reviewer',
        labels: ['channel-architecture'],
        llmConnection: 'pi-copilot',
        model: 'auto',
        hermesProfile: undefined,
        enabledSourceSlugs: undefined,
        permissionMode: undefined,
        workingDirectory: undefined,
      },
    ]);
    expect(runtime.sent.map(item => item.sessionId)).toEqual(['session-1', 'session-2']);
    expect(runtime.sent[0]?.message).toContain('Channel: Architecture');
    expect(runtime.sent[0]?.message).toContain('@hermes-lead @pi-reviewer revisem o plano');
  });

  it('dispatches multiple Hermes profiles as separate channel participants with shared transcript', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    const result = await orchestrator.sendMessage({
      channel: {
        ...channel,
        participants: [
          {
            id: 'default',
            displayName: 'Hermes Default',
            llmConnection: 'hermes',
            hermesProfile: 'default',
          },
          {
            id: 'server-ops',
            displayName: 'Server Ops',
            llmConnection: 'hermes',
            hermesProfile: 'server-ops',
          },
        ],
      },
      text: '@default @server-ops revisem o plano juntos',
      authorId: 'human',
      recentMessages: [
        { authorId: 'human', text: '@default crie um plano inicial' },
        { authorId: 'default', text: 'Plano inicial: usar canal compartilhado.' },
      ],
    });

    expect(result.targetedParticipantIds).toEqual(['default', 'server-ops']);
    expect(runtime.created.map(item => item.hermesProfile)).toEqual(['default', 'server-ops']);
    expect(runtime.created.every(item => item.llmConnection === 'hermes')).toBe(true);
    expect(runtime.sent.map(item => item.sessionId)).toEqual(['session-1', 'session-2']);
    expect(runtime.sent[1]?.message).toContain('Recent channel context:');
    expect(runtime.sent[1]?.message).toContain('- default: Plano inicial: usar canal compartilhado.');
  });

  it('routes channel work to one Hermes orchestrator with the worker roster in orchestrator mode', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    const result = await orchestrator.sendMessage({
      channel: {
        ...channel,
        participants: [
          {
            id: 'lead',
            displayName: 'Hermes Lead',
            llmConnection: 'hermes',
            hermesProfile: 'lead',
          },
          {
            id: 'server-ops',
            displayName: 'Server Ops',
            llmConnection: 'hermes',
            hermesProfile: 'server-ops',
          },
          {
            id: 'research',
            displayName: 'Research',
            llmConnection: 'hermes',
            hermesProfile: 'research',
          },
        ],
        routing: {
          mode: 'orchestrator',
          leadParticipantId: 'lead',
          allowAllMention: true,
        },
      },
      text: '@server-ops @research criem um plano e revisem riscos',
      authorId: 'human',
      mentionedParticipantIds: ['server-ops', 'research'],
    });

    expect(result.targetedParticipantIds).toEqual(['lead']);
    expect(runtime.created).toHaveLength(1);
    expect(runtime.created[0]?.hermesProfile).toBe('lead');
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.message).toContain('<<craft-channel-orchestrator hidden-from-user>>');
    expect(runtime.sent[0]?.message).toContain('@server-ops');
    expect(runtime.sent[0]?.message).toContain('@research');
    expect(runtime.sent[0]?.message).toContain('hermes kanban create');
    expect(result.agentMessages).toEqual([
      { participantId: 'lead', sessionId: 'session-1', text: 'response from session-1' },
    ]);
  });

  it('reuses participant sessions on later messages in the same channel', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    await orchestrator.sendMessage({ channel, text: '@hermes-lead cria um plano', authorId: 'human' });
    await orchestrator.sendMessage({ channel, text: '@hermes-lead ajuste com base no Claudio', authorId: 'human' });

    expect(runtime.created).toHaveLength(1);
    expect(runtime.sent.map(item => item.sessionId)).toEqual(['session-1', 'session-1']);
  });

  it('does not route untagged messages in manual-tags mode', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    const result = await orchestrator.sendMessage({ channel, text: 'só uma nota', authorId: 'human' });

    expect(result.targetedParticipantIds).toEqual([]);
    expect(runtime.created).toEqual([]);
    expect(runtime.sent).toEqual([]);
  });

  it('routes untagged lead-mode messages to the inferred Hermes lead even without an explicit lead id', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    const result = await orchestrator.sendMessage({
      channel: {
        ...channel,
        routing: { mode: 'lead' },
      },
      text: 'organize isso no canal',
      authorId: 'human',
    });

    expect(result.targetedParticipantIds).toEqual(['hermes-lead']);
    expect(runtime.created).toHaveLength(1);
    expect(runtime.created[0]?.hermesProfile).toBe('lead');
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.message).toContain('organize isso no canal');
  });
});
