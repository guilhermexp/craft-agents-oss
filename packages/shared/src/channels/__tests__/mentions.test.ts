import { describe, expect, it } from 'bun:test';
import { resolveChannelMentions } from '../mentions.ts';
import type { ChannelParticipant } from '../types.ts';

const participants: ChannelParticipant[] = [
  { id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes' },
  { id: 'claudio', displayName: 'Claudio', llmConnection: 'anthropic-main' },
  { id: 'pi-reviewer', displayName: 'Pi Reviewer', llmConnection: 'pi-copilot' },
];

describe('resolveChannelMentions', () => {
  it('extracts multiple participant mentions from message text', () => {
    const result = resolveChannelMentions({
      text: '@hermes-lead @claudio revisem esse plano',
      participants,
    });

    expect(result.mentionedParticipantIds).toEqual(['hermes-lead', 'claudio']);
    expect(result.unknownMentions).toEqual([]);
  });

  it('deduplicates mentions and normalizes case', () => {
    const result = resolveChannelMentions({
      text: '@Hermes-Lead @hermes-lead',
      participants,
    });

    expect(result.mentionedParticipantIds).toEqual(['hermes-lead']);
  });

  it('does not treat email addresses as participant mentions', () => {
    const result = resolveChannelMentions({
      text: 'manda para pessoa@example.com e chama @pi-reviewer',
      participants,
    });

    expect(result.mentionedParticipantIds).toEqual(['pi-reviewer']);
    expect(result.unknownMentions).toEqual([]);
  });

  it('prefers explicit UI mention ids over text parsing', () => {
    const result = resolveChannelMentions({
      text: '@unknown @hermes-lead',
      explicitMentionedParticipantIds: ['claudio'],
      participants,
    });

    expect(result.mentionedParticipantIds).toEqual(['claudio']);
    expect(result.unknownMentions).toEqual([]);
  });

  it('expands @all only when allowed', () => {
    const denied = resolveChannelMentions({
      text: '@all revisem',
      participants,
    });
    expect(denied.mentionedParticipantIds).toEqual([]);
    expect(denied.unknownMentions).toEqual(['all']);

    const allowed = resolveChannelMentions({
      text: '@all revisem',
      participants,
      allowAll: true,
    });
    expect(allowed.mentionedParticipantIds).toEqual(['hermes-lead', 'claudio', 'pi-reviewer']);
  });
});
