import { describe, expect, it } from 'bun:test';
import { createChannelOrchestrator, type ChannelAgentRuntime, type ChannelDispatchStore } from './channel-orchestrator.ts';
import { warRoomChannelId, type WarRoomChannel } from '@craft-agent/shared/channels';

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

function createDispatchStore(): ChannelDispatchStore & {
  created: Array<Parameters<ChannelDispatchStore['create']>[0]>;
  updates: Array<{ dispatchId: string; updates: Parameters<ChannelDispatchStore['update']>[1] }>;
} {
  let next = 1;
  const created: Array<Parameters<ChannelDispatchStore['create']>[0]> = [];
  const updates: Array<{ dispatchId: string; updates: Parameters<ChannelDispatchStore['update']>[1] }> = [];
  return {
    created,
    updates,
    create(input) {
      created.push(input);
      const now = Date.now();
      return {
        id: `dispatch-${next++}`,
        channelId: input.channelId,
        participantId: input.participantId,
        sourceMessageId: input.sourceMessageId,
        parentMessageId: input.parentMessageId,
        sourceSessionId: input.sourceSessionId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };
    },
    update(dispatchId, update) {
      updates.push({ dispatchId, updates: update });
      const original = created[Number(dispatchId.replace('dispatch-', '')) - 1]!;
      const now = Date.now();
      return {
        id: dispatchId,
        channelId: original.channelId,
        participantId: original.participantId,
        sourceMessageId: original.sourceMessageId,
        parentMessageId: original.parentMessageId,
        sourceSessionId: original.sourceSessionId,
        status: update.status ?? 'queued',
        error: update.error,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}

const channel: WarRoomChannel = {
  id: warRoomChannelId('architecture'),
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

  it('records dispatch status transitions for successful and failed participants', async () => {
    const runtime = createRuntime();
    runtime.sendMessage = async (input) => {
      runtime.sent.push(input);
      if (input.sessionId === 'session-2') throw new Error('pi unavailable');
      return { assistantText: `response from ${input.sessionId}` };
    };
    const dispatchStore = createDispatchStore();
    const orchestrator = createChannelOrchestrator({ runtime, dispatchStore });

    const result = await orchestrator.sendMessage({
      channel,
      text: '@hermes-lead @pi-reviewer revisem o plano',
      authorId: 'human',
      sourceMessageId: 'message-1',
      parentMessageId: 'parent-1',
      sourceSessionId: 'source-session',
    });

    expect(result.targetedParticipantIds).toEqual(['hermes-lead', 'pi-reviewer']);
    expect(result.failures).toEqual([{ participantId: 'pi-reviewer', message: 'pi unavailable' }]);
    expect(dispatchStore.created.map(item => ({
      channelId: item.channelId,
      participantId: item.participantId,
      sourceMessageId: item.sourceMessageId,
      parentMessageId: item.parentMessageId,
      sourceSessionId: item.sourceSessionId,
    }))).toEqual([
      {
        channelId: 'architecture',
        participantId: 'hermes-lead',
        sourceMessageId: 'message-1',
        parentMessageId: 'parent-1',
        sourceSessionId: 'source-session',
      },
      {
        channelId: 'architecture',
        participantId: 'pi-reviewer',
        sourceMessageId: 'message-1',
        parentMessageId: 'parent-1',
        sourceSessionId: 'source-session',
      },
    ]);
    expect(dispatchStore.updates.map(item => [item.dispatchId, item.updates.status, item.updates.error])).toEqual([
      ['dispatch-1', 'running', undefined],
      ['dispatch-2', 'running', undefined],
      ['dispatch-1', 'completed', undefined],
      ['dispatch-2', 'failed', 'pi unavailable'],
    ]);
    expect(result.dispatches.map(dispatch => ({
      id: dispatch.id,
      participantId: dispatch.participantId,
      status: dispatch.status,
      error: dispatch.error,
    }))).toEqual([
      { id: 'dispatch-1', participantId: 'hermes-lead', status: 'completed', error: undefined },
      { id: 'dispatch-2', participantId: 'pi-reviewer', status: 'failed', error: 'pi unavailable' },
    ]);
  });

  it('dispatches direct channel tool work to a requested non-Hermes participant', async () => {
    const runtime = createRuntime();
    const dispatchStore = createDispatchStore();
    const orchestrator = createChannelOrchestrator({ runtime, dispatchStore });

    const result = await orchestrator.dispatchToParticipant({
      channel,
      participantId: 'pi-reviewer',
      text: 'faça review deste plano',
      sourceMessageId: 'message-2',
      sourceSessionId: 'session-lead',
    });

    expect(result.targetedParticipantIds).toEqual(['pi-reviewer']);
    expect(runtime.created[0]?.llmConnection).toBe('pi-copilot');
    expect(runtime.sent[0]?.message).toContain('faça review deste plano');
    expect(result.dispatches[0]?.status).toBe('completed');
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

  it('adds Craft product context only when supplied by craft-bridge', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    await orchestrator.sendMessage({
      channel: {
        ...channel,
        craftBridgeContext: {
          provider: 'craft-bridge',
          sourceSlug: 'craft-product-docs',
          description: 'Workspace product docs',
        },
      },
      text: '@hermes-lead use o contexto Craft',
      authorId: 'human',
    });

    expect(runtime.sent[0]?.message).toContain('Craft document context:');
    expect(runtime.sent[0]?.message).toContain('- provider: craft-bridge');
    expect(runtime.sent[0]?.message).toContain('- source: craft-product-docs');
  });

  it('keeps generic War Room routing when no Craft Bridge context is present', async () => {
    const runtime = createRuntime();
    const orchestrator = createChannelOrchestrator({ runtime });

    await orchestrator.sendMessage({
      channel,
      text: '@hermes-lead siga o fluxo normal',
      authorId: 'human',
    });

    expect(runtime.sent[0]?.message).toContain('Channel: Architecture');
    expect(runtime.sent[0]?.message).not.toContain('Craft document context:');
  });
});
