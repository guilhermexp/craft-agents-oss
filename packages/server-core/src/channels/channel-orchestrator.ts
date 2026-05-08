import type { PermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { ChannelConfig, ChannelParticipant } from '@craft-agent/shared/channels';
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
}

export interface ChannelOrchestratorDeps {
  runtime: ChannelAgentRuntime;
}

export interface SendChannelMessageInput {
  channel: ChannelConfig;
  text: string;
  authorId: string;
  mentionedParticipantIds?: string[];
  recentMessages?: Array<{ authorId: string; text: string }>;
}

export interface SendChannelMessageResult {
  targetedParticipantIds: string[];
  unknownMentions: string[];
  failures: Array<{ participantId: string; message: string }>;
  agentMessages: Array<{ participantId: string; sessionId: string; text: string }>;
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
  sendTaskUpdate(input: {
    channel: ChannelConfig;
    tasks: ChannelTaskUpdate[];
    recentMessages?: Array<{ authorId: string; text: string }>;
  }): Promise<SendChannelMessageResult>;
}

function sessionKey(channelId: string, participantId: string): string {
  return `${channelId}:${participantId}`;
}

function routingMode(channel: ChannelConfig): 'manual-tags' | 'lead' | 'all' | 'orchestrator' {
  return channel.routing?.mode ?? 'manual-tags';
}

function resolveLeadParticipant(channel: ChannelConfig): ChannelParticipant | undefined {
  const participants = channel.participants ?? [];
  if (channel.routing?.leadParticipantId) {
    return participants.find(participant => participant.id === channel.routing?.leadParticipantId);
  }
  return participants.find(participant => participant.llmConnection === 'hermes')
    ?? participants[0];
}

function resolveTargets(
  channel: ChannelConfig,
  text: string,
  explicitMentionedParticipantIds?: string[],
): { participants: ChannelParticipant[]; unknownMentions: string[] } {
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
        .filter((participant): participant is ChannelParticipant => participant !== undefined),
      unknownMentions: mentions.unknownMentions,
    };
  }

  if (routingMode(channel) === 'all') {
    return { participants, unknownMentions: mentions.unknownMentions };
  }

  if (mode === 'lead' && channel.routing?.leadParticipantId) {
    const lead = resolveLeadParticipant(channel);
    return { participants: lead ? [lead] : [], unknownMentions: mentions.unknownMentions };
  }

  return { participants: [], unknownMentions: mentions.unknownMentions };
}

function kanbanAssigneeSlug(participant: ChannelParticipant): string {
  return participant.llmConnection === 'hermes' && participant.hermesProfile
    ? participant.hermesProfile
    : participant.id;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function buildRoster(channel: ChannelConfig, orchestrator: ChannelParticipant): string {
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
  channel: ChannelConfig;
  participant: ChannelParticipant;
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

  lines.push('Current user message:');
  lines.push(input.text);
  lines.push('');
  lines.push('Reply for the channel. Consider the shared channel context, but do not assume other agent sessions share your private history.');

  return lines.join('\n');
}

function buildOrchestratorPacket(input: {
  channel: ChannelConfig;
  orchestrator: ChannelParticipant;
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

  lines.push('Current user message:');
  lines.push(input.text);
  return lines.join('\n');
}

function buildTaskUpdatePacket(input: {
  channel: ChannelConfig;
  orchestrator: ChannelParticipant;
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
    channel: ChannelConfig,
    participant: ChannelParticipant,
  ): Promise<string> {
    const key = sessionKey(channel.id, participant.id);
    const existing = participantSessions.get(key);
    if (existing) return existing;

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
    participantSessions.set(key, session.id);
    return session.id;
  }

  return {
    async sendMessage(input) {
      const targets = resolveTargets(input.channel, input.text, input.mentionedParticipantIds);
      const failures: Array<{ participantId: string; message: string }> = [];
      const agentMessages: Array<{ participantId: string; sessionId: string; text: string }> = [];
      const mode = routingMode(input.channel);

      const results = await Promise.allSettled(targets.participants.map(async participant => {
        const sessionId = await ensureParticipantSession(input.channel, participant);
        const response = await deps.runtime.sendMessage({
          sessionId,
          message: mode === 'orchestrator'
            ? buildOrchestratorPacket({
                channel: input.channel,
                orchestrator: participant,
                text: input.text,
                mentionedParticipantIds: input.mentionedParticipantIds,
                recentMessages: input.recentMessages,
              })
            : buildChannelWorkPacket({
                channel: input.channel,
                participant,
                text: input.text,
                recentMessages: input.recentMessages,
              }),
        });
        const assistantText = response.assistantText?.trim();
        if (assistantText) {
          agentMessages.push({ participantId: participant.id, sessionId, text: assistantText });
        }
      }));

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
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
      };
    },
  };
}
