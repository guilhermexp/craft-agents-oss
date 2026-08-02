import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { WarRoomChannel, WarRoomDispatch, WarRoomParticipant } from '@craft-agent/shared/channels';
import { resolveChannelMentions } from '@craft-agent/shared/channels/mentions';
import { getHermesKanbanHome } from './hermes-kanban';

export interface ChannelAgentSessionCreateInput {
  name: string;
  labels: string[];
  llmConnection: string;
  model?: string;
  hermesProfile?: string;
  enabledSourceSlugs?: string[];
  permissionMode?: PermissionMode;
  workingDirectory?: string;
}

export interface ChannelAgentRuntime {
  createSession(input: ChannelAgentSessionCreateInput): Promise<{ id: string }>;
  sendMessage(input: { sessionId: string; message: string }): Promise<{ assistantText?: string }>;
  sessionExists(sessionId: string): Promise<boolean>;
}

export interface ChannelSessionBindingStore {
  get(channelId: string, participantId: string): string | undefined;
  set(channelId: string, participantId: string, sessionId: string): void;
}

export interface ChannelOrchestratorDeps {
  runtime: ChannelAgentRuntime;
  dispatchStore?: ChannelDispatchStore;
  sessionBindingStore?: ChannelSessionBindingStore;
}

export interface ChannelDispatchStore {
  create(input: {
    channelId: string;
    participantId: string;
    sourceMessageId: string;
    parentMessageId?: string;
    sourceSessionId?: string;
  }): WarRoomDispatch;
  update(dispatchId: string, updates: {
    status?: WarRoomDispatch['status'];
    error?: string;
  }): WarRoomDispatch;
}

export interface SendChannelMessageInput {
  channel: WarRoomChannel;
  text: string;
  authorId: string;
  mentionedParticipantIds?: string[];
  recentMessages?: Array<{ authorId: string; text: string }>;
  sourceMessageId?: string;
  parentMessageId?: string;
  sourceSessionId?: string;
}

export interface SendChannelMessageResult {
  targetedParticipantIds: string[];
  unknownMentions: string[];
  failures: Array<{ participantId: string; message: string }>;
  agentMessages: Array<{ participantId: string; sessionId: string; text: string }>;
  dispatches: WarRoomDispatch[];
}

export interface ChannelTaskUpdate {
  id: string;
  title: string;
  assignee?: string | null;
  status: string;
  result?: string | null;
}

export interface ChannelOrchestrator {
  sendMessage(input: SendChannelMessageInput): Promise<SendChannelMessageResult>;
  dispatchToParticipant(input: {
    channel: WarRoomChannel;
    participantId: string;
    text: string;
    recentMessages?: Array<{ authorId: string; text: string }>;
    sourceMessageId?: string;
    parentMessageId?: string;
    sourceSessionId?: string;
  }): Promise<SendChannelMessageResult>;
  sendTaskUpdate(input: {
    channel: WarRoomChannel;
    tasks: ChannelTaskUpdate[];
    recentMessages?: Array<{ authorId: string; text: string }>;
  }): Promise<SendChannelMessageResult>;
}

function sessionKey(channelId: string, participantId: string): string {
  return `${channelId}:${participantId}`;
}

function routingMode(channel: WarRoomChannel): 'manual-tags' | 'lead' | 'all' | 'orchestrator' {
  return channel.routing?.mode ?? 'manual-tags';
}

function resolveLeadParticipant(channel: WarRoomChannel): WarRoomParticipant | undefined {
  const participants = channel.participants ?? [];
  if (channel.routing?.leadParticipantId) {
    return participants.find(participant => participant.id === channel.routing?.leadParticipantId);
  }
  return participants.find(participant => participant.llmConnection === 'hermes')
    ?? participants[0];
}

export function resolveChannelTargets(
  channel: WarRoomChannel,
  text: string,
  explicitMentionedParticipantIds?: string[],
): { participants: WarRoomParticipant[]; unknownMentions: string[] } {
  const participants = channel.participants ?? [];
  const mode = routingMode(channel);
  const mentions = resolveChannelMentions({
    text,
    participants,
    explicitMentionedParticipantIds,
    allowAll: channel.routing?.allowAllMention ?? routingMode(channel) === 'all',
  });

  if (mode === 'orchestrator') {
    const lead = resolveLeadParticipant(channel);
    return { participants: lead ? [lead] : [], unknownMentions: mentions.unknownMentions };
  }

  if (mentions.mentionedParticipantIds.length > 0) {
    return {
      participants: mentions.mentionedParticipantIds
        .map(id => participants.find(participant => participant.id === id))
        .filter((participant): participant is WarRoomParticipant => participant !== undefined),
      unknownMentions: mentions.unknownMentions,
    };
  }

  if (routingMode(channel) === 'all') {
    return { participants, unknownMentions: mentions.unknownMentions };
  }

  if (mode === 'lead') {
    const lead = resolveLeadParticipant(channel);
    return { participants: lead ? [lead] : [], unknownMentions: mentions.unknownMentions };
  }

  return { participants: [], unknownMentions: mentions.unknownMentions };
}

function kanbanAssigneeSlug(participant: WarRoomParticipant): string {
  return participant.llmConnection === 'hermes' && participant.hermesProfile
    ? participant.hermesProfile
    : participant.id;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function buildRoster(channel: WarRoomChannel, orchestrator: WarRoomParticipant): string {
  const participants = channel.participants ?? [];
  const workers = participants.filter(participant => participant.id !== orchestrator.id);
  if (workers.length === 0) {
    return '- No worker profiles are configured for this channel yet.';
  }

  return workers.map(participant => {
    const assignee = kanbanAssigneeSlug(participant);
    const parts = [
      `- @${participant.id}`,
      `displayName="${participant.displayName}"`,
      `connection="${participant.llmConnection}"`,
      `kanbanAssignee="${assignee}"`,
    ];
    if (participant.hermesProfile) parts.push(`hermesProfile="${participant.hermesProfile}"`);
    if (participant.model) parts.push(`model="${participant.model}"`);
    return parts.join(' ');
  }).join('\n');
}

function buildChannelWorkPacket(input: {
  channel: WarRoomChannel;
  participant: WarRoomParticipant;
  text: string;
  recentMessages?: Array<{ authorId: string; text: string }>;
}): string {
  const lines = [
    `Channel: ${input.channel.name}`,
    input.channel.description ? `Channel description: ${input.channel.description}` : null,
    `You are responding as: ${input.participant.displayName} (@${input.participant.id})`,
    '',
  ].filter((line): line is string => line !== null);

  if (input.recentMessages && input.recentMessages.length > 0) {
    lines.push('Recent channel context:');
    for (const message of input.recentMessages.slice(-20)) {
      lines.push(`- ${message.authorId}: ${message.text}`);
    }
    lines.push('');
  }

  if (input.channel.craftBridgeContext) {
    lines.push('Craft document context:');
    lines.push(`- provider: ${input.channel.craftBridgeContext.provider}`);
    lines.push(`- source: ${input.channel.craftBridgeContext.sourceSlug}`);
    if (input.channel.craftBridgeContext.description) {
      lines.push(`- description: ${input.channel.craftBridgeContext.description}`);
    }
    lines.push('');
  }

  lines.push('Current user message:');
  lines.push(input.text);
  lines.push('');
  lines.push('Reply for the channel. Consider the shared channel context, but do not assume other agent sessions share your private history.');

  return lines.join('\n');
}

function buildOrchestratorPacket(input: {
  channel: WarRoomChannel;
  orchestrator: WarRoomParticipant;
  text: string;
  mentionedParticipantIds?: string[];
  recentMessages?: Array<{ authorId: string; text: string }>;
}): string {
  const requested = input.mentionedParticipantIds?.length
    ? input.mentionedParticipantIds.map(id => `@${id}`).join(', ')
    : 'none';

  const hermesHome = getHermesKanbanHome();
  const hermesHomeAssignment = `HERMES_HOME=${shellDoubleQuote(hermesHome)}`;

  const lines = [
    '<<craft-channel-orchestrator hidden-from-user>>',
    `Channel: ${input.channel.name}`,
    input.channel.description ? `Channel description: ${input.channel.description}` : null,
    `You are the channel orchestrator: ${input.orchestrator.displayName} (@${input.orchestrator.id}).`,
    '',
    '## Active worker roster',
    buildRoster(input.channel, input.orchestrator),
    '',
    '## Operating rules',
    '- Act like a Hermes War Room orchestrator: decompose, delegate, then summarize.',
    '- Do not perform worker tasks yourself when the request requires specialized review, research, implementation, or parallel work.',
    '- Delegate worker work through Hermes Kanban/gateway when available, using the worker `kanbanAssignee` values from the roster as assignees. Do not use the UI mention id if `kanbanAssignee` differs.',
    `- Use the shared Craft Hermes home explicitly so the dispatcher and workers see the same board: ${hermesHomeAssignment}`,
    `- If using the terminal, use commands shaped exactly like: ${hermesHomeAssignment} hermes kanban create "<title>" --assignee <kanbanAssignee> --body "<body>" --json.`,
    '- `title` is positional; do not use `--title`. Add `--parent <task-id>` for dependencies only after capturing real ids from earlier `--json` output.',
    '- If workers were explicitly mentioned by the user, delegate to those workers unless the request is only a direct question.',
    '- If delegation is not possible, say what is missing instead of pretending worker tasks were created.',
    '- When worker results are later provided in this channel, consolidate them into one answer for the user.',
    '<<end-craft-channel-orchestrator>>',
    '',
    `Requested workers from mentions: ${requested}`,
    '',
  ].filter((line): line is string => line !== null);

  if (input.recentMessages && input.recentMessages.length > 0) {
    lines.push('Recent channel context:');
    for (const message of input.recentMessages.slice(-30)) {
      lines.push(`- ${message.authorId}: ${message.text}`);
    }
    lines.push('');
  }

  if (input.channel.craftBridgeContext) {
    lines.push('Craft document context:');
    lines.push(`- provider: ${input.channel.craftBridgeContext.provider}`);
    lines.push(`- source: ${input.channel.craftBridgeContext.sourceSlug}`);
    if (input.channel.craftBridgeContext.description) {
      lines.push(`- description: ${input.channel.craftBridgeContext.description}`);
    }
    lines.push('');
  }

  lines.push('Current user message:');
  lines.push(input.text);
  return lines.join('\n');
}

function buildTaskUpdatePacket(input: {
  channel: WarRoomChannel;
  orchestrator: WarRoomParticipant;
  tasks: ChannelTaskUpdate[];
  recentMessages?: Array<{ authorId: string; text: string }>;
}): string {
  const lines = [
    '<<craft-channel-task-update hidden-from-user>>',
    `Channel: ${input.channel.name}`,
    `You are the channel orchestrator: ${input.orchestrator.displayName} (@${input.orchestrator.id}).`,
    'The following delegated Hermes Kanban tasks reached a terminal state.',
    'Summarize the worker results for the user in the same language as the channel conversation.',
    'Do not re-delegate unless the user explicitly asked for follow-up work.',
    '',
    'Completed or blocked tasks:',
  ];

  for (const task of input.tasks) {
    lines.push(`- ${task.id} (${task.assignee ?? 'unassigned'}) — ${task.status}: ${task.title}`);
    if (task.result?.trim()) {
      lines.push(`  result: ${task.result.trim().replace(/\s+/g, ' ').slice(0, 1200)}`);
    }
  }

  if (input.recentMessages && input.recentMessages.length > 0) {
    lines.push('');
    lines.push('Recent channel context:');
    for (const message of input.recentMessages.slice(-30)) {
      lines.push(`- ${message.authorId}: ${message.text}`);
    }
  }

  lines.push('<<end-craft-channel-task-update>>');
  return lines.join('\n');
}

export function createChannelOrchestrator(deps: ChannelOrchestratorDeps): ChannelOrchestrator {
  const participantSessions = new Map<string, string>();

  async function ensureParticipantSession(
    channel: WarRoomChannel,
    participant: WarRoomParticipant,
  ): Promise<string> {
    const key = sessionKey(channel.id, participant.id);
    const cached = participantSessions.get(key);
    if (cached) return cached;

    const persisted = deps.sessionBindingStore?.get(channel.id, participant.id);
    if (persisted && await deps.runtime.sessionExists(persisted)) {
      participantSessions.set(key, persisted);
      return persisted;
    }

    const session = await deps.runtime.createSession({
      name: `${channel.name} / ${participant.displayName}`,
      labels: [channel.labelId],
      llmConnection: participant.llmConnection,
      model: participant.model,
      hermesProfile: participant.hermesProfile,
      enabledSourceSlugs: participant.defaultSourceSlugs ?? channel.defaultSourceSlugs,
      permissionMode: participant.permissionMode ?? channel.defaultPermissionMode,
      workingDirectory: participant.workingDirectory ?? channel.workingDirectory,
    });
    // Persist the binding before caching in memory. If the write throws, the
    // cache stays empty so a later call retries instead of reusing a session
    // that was never persisted (which would orphan on the next restart).
    deps.sessionBindingStore?.set(channel.id, participant.id, session.id);
    participantSessions.set(key, session.id);
    return session.id;
  }

  function createDispatches(input: {
    channel: WarRoomChannel;
    participants: WarRoomParticipant[];
    sourceMessageId?: string;
    parentMessageId?: string;
    sourceSessionId?: string;
  }): Map<string, WarRoomDispatch> {
    const dispatches = new Map<string, WarRoomDispatch>();
    if (!deps.dispatchStore || !input.sourceMessageId) return dispatches;

    for (const participant of input.participants) {
      const dispatch = deps.dispatchStore.create({
        channelId: input.channel.id,
        participantId: participant.id,
        sourceMessageId: input.sourceMessageId,
        parentMessageId: input.parentMessageId,
        sourceSessionId: input.sourceSessionId,
      });
      dispatches.set(participant.id, dispatch);
    }
    return dispatches;
  }

  function updateDispatch(
    dispatches: Map<string, WarRoomDispatch>,
    participantId: string,
    updates: Parameters<ChannelDispatchStore['update']>[1],
  ): void {
    const dispatch = dispatches.get(participantId);
    if (!dispatch || !deps.dispatchStore) return;
    dispatches.set(participantId, deps.dispatchStore.update(dispatch.id, updates));
  }

  async function dispatchParticipant(input: {
    channel: WarRoomChannel;
    participant: WarRoomParticipant;
    text: string;
    recentMessages?: Array<{ authorId: string; text: string }>;
    dispatches: Map<string, WarRoomDispatch>;
    mode?: ReturnType<typeof routingMode>;
    mentionedParticipantIds?: string[];
  }): Promise<{ participantId: string; sessionId: string; text?: string }> {
    updateDispatch(input.dispatches, input.participant.id, { status: 'running' });
    try {
      const sessionId = await ensureParticipantSession(input.channel, input.participant);
      const response = await deps.runtime.sendMessage({
        sessionId,
        message: input.mode === 'orchestrator'
          ? buildOrchestratorPacket({
              channel: input.channel,
              orchestrator: input.participant,
              text: input.text,
              mentionedParticipantIds: input.mentionedParticipantIds,
              recentMessages: input.recentMessages,
            })
          : buildChannelWorkPacket({
              channel: input.channel,
              participant: input.participant,
              text: input.text,
              recentMessages: input.recentMessages,
            }),
      });
      updateDispatch(input.dispatches, input.participant.id, { status: 'completed' });
      return {
        participantId: input.participant.id,
        sessionId,
        text: response.assistantText?.trim(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDispatch(input.dispatches, input.participant.id, { status: 'failed', error: message });
      throw error;
    }
  }

  return {
    async sendMessage(input) {
      const targets = resolveChannelTargets(input.channel, input.text, input.mentionedParticipantIds);
      const failures: Array<{ participantId: string; message: string }> = [];
      const agentMessages: Array<{ participantId: string; sessionId: string; text: string }> = [];
      const mode = routingMode(input.channel);
      const dispatches = createDispatches({
        channel: input.channel,
        participants: targets.participants,
        sourceMessageId: input.sourceMessageId,
        parentMessageId: input.parentMessageId,
        sourceSessionId: input.sourceSessionId,
      });

      const results = await Promise.allSettled(targets.participants.map(participant => (
        dispatchParticipant({
          channel: input.channel,
          participant,
          text: input.text,
          recentMessages: input.recentMessages,
          dispatches,
          mode,
          mentionedParticipantIds: input.mentionedParticipantIds,
        })
      )));

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.text) {
            agentMessages.push({
              participantId: result.value.participantId,
              sessionId: result.value.sessionId,
              text: result.value.text,
            });
          }
        } else {
          const participant = targets.participants[index];
          if (!participant) return;
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failures.push({ participantId: participant.id, message });
        }
      });

      return {
        targetedParticipantIds: targets.participants.map(participant => participant.id),
        unknownMentions: targets.unknownMentions,
        failures,
        agentMessages,
        dispatches: targets.participants
          .map(participant => dispatches.get(participant.id))
          .filter((dispatch): dispatch is WarRoomDispatch => dispatch !== undefined),
      };
    },
    async dispatchToParticipant(input) {
      const participant = (input.channel.participants ?? []).find(item => item.id === input.participantId);
      if (!participant) {
        return {
          targetedParticipantIds: [],
          unknownMentions: [],
          failures: [{ participantId: input.participantId, message: `Participant '${input.participantId}' not found in channel` }],
          agentMessages: [],
          dispatches: [],
        };
      }

      const dispatches = createDispatches({
        channel: input.channel,
        participants: [participant],
        sourceMessageId: input.sourceMessageId,
        parentMessageId: input.parentMessageId,
        sourceSessionId: input.sourceSessionId,
      });
      const failures: Array<{ participantId: string; message: string }> = [];
      const agentMessages: Array<{ participantId: string; sessionId: string; text: string }> = [];

      const result = await Promise.allSettled([
        dispatchParticipant({
          channel: input.channel,
          participant,
          text: input.text,
          recentMessages: input.recentMessages,
          dispatches,
        }),
      ]);

      const settled = result[0];
      if (settled?.status === 'fulfilled') {
        if (settled.value.text) {
          agentMessages.push({
            participantId: settled.value.participantId,
            sessionId: settled.value.sessionId,
            text: settled.value.text,
          });
        }
      } else if (settled?.status === 'rejected') {
        const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        failures.push({ participantId: participant.id, message });
      }

      return {
        targetedParticipantIds: [participant.id],
        unknownMentions: [],
        failures,
        agentMessages,
        dispatches: [dispatches.get(participant.id)].filter((dispatch): dispatch is WarRoomDispatch => dispatch !== undefined),
      };
    },
    async sendTaskUpdate(input) {
      const lead = resolveLeadParticipant(input.channel);
      if (!lead) {
        return {
          targetedParticipantIds: [],
          unknownMentions: [],
          failures: [{ participantId: 'orchestrator', message: 'No orchestrator participant configured for channel' }],
          agentMessages: [],
          dispatches: [],
        };
      }

      const failures: Array<{ participantId: string; message: string }> = [];
      const agentMessages: Array<{ participantId: string; sessionId: string; text: string }> = [];
      try {
        const sessionId = await ensureParticipantSession(input.channel, lead);
        const response = await deps.runtime.sendMessage({
          sessionId,
          message: buildTaskUpdatePacket({
            channel: input.channel,
            orchestrator: lead,
            tasks: input.tasks,
            recentMessages: input.recentMessages,
          }),
        });
        const assistantText = response.assistantText?.trim();
        if (assistantText) {
          agentMessages.push({ participantId: lead.id, sessionId, text: assistantText });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ participantId: lead.id, message });
      }

      return {
        targetedParticipantIds: [lead.id],
        unknownMentions: [],
        failures,
        agentMessages,
        dispatches: [],
      };
    },
  };
}
