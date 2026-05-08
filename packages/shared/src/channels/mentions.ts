import type { ChannelParticipant } from './types.ts';

const MENTION_PATTERN = /(?:^|[^a-zA-Z0-9_])@([a-z0-9][a-z0-9-]{1,39})\b/gi;

export interface ResolveChannelMentionsInput {
  text: string;
  participants: ChannelParticipant[];
  explicitMentionedParticipantIds?: string[];
  allowAll?: boolean;
}

export interface ResolveChannelMentionsResult {
  mentionedParticipantIds: string[];
  unknownMentions: string[];
}

function uniqueInOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function textMentionSlugs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const slug = match[1];
    if (slug) out.push(slug);
  }
  return uniqueInOrder(out);
}

export function resolveChannelMentions(input: ResolveChannelMentionsInput): ResolveChannelMentionsResult {
  const participantIds = new Set(input.participants.map(participant => participant.id.toLowerCase()));
  const rawMentions = input.explicitMentionedParticipantIds !== undefined
    ? uniqueInOrder(input.explicitMentionedParticipantIds)
    : textMentionSlugs(input.text);

  const mentionedParticipantIds: string[] = [];
  const unknownMentions: string[] = [];

  for (const mention of rawMentions) {
    if (mention === 'all') {
      if (input.allowAll) {
        for (const participant of input.participants) {
          if (!mentionedParticipantIds.includes(participant.id)) {
            mentionedParticipantIds.push(participant.id);
          }
        }
      } else {
        unknownMentions.push(mention);
      }
      continue;
    }

    if (participantIds.has(mention)) {
      mentionedParticipantIds.push(mention);
    } else {
      unknownMentions.push(mention);
    }
  }

  return {
    mentionedParticipantIds: uniqueInOrder(mentionedParticipantIds),
    unknownMentions: uniqueInOrder(unknownMentions),
  };
}
