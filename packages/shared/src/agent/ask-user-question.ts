/**
 * Shared helpers for the interactive AskUserQuestion tool.
 *
 * Both the Claude backend (via its PreToolUse hook) and the Pi backend (via a
 * registered tool) intercept `AskUserQuestion`, surface the questions to the
 * UI, park until the user answers, then feed the answers back as the tool
 * result. These helpers keep validation and result-shaping identical across
 * backends so the renderer sees one consistent contract.
 */
import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionResponse,
} from '@craft-agent/core/types';

/** How long a parked questionnaire waits for an answer before auto-skipping. */
export const ASK_USER_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/** The canonical tool name for the interactive questionnaire. */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOption(raw: unknown): AskUserQuestionOption | null {
  if (!isRecord(raw)) return null;
  const { label, description, preview } = raw;
  if (typeof label !== 'string' || label.trim().length === 0) return null;
  return {
    label,
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof preview === 'string' ? { preview } : {}),
  };
}

/**
 * Validate and normalize a raw AskUserQuestion tool input.
 *
 * Returns the normalized questions, or `null` when the payload is malformed
 * (missing/empty `questions`, a question without text, or a question without
 * at least one valid option). Callers block malformed calls so the turn never
 * parks on an unanswerable questionnaire.
 */
export function validateAskUserQuestions(input: unknown): AskUserQuestionItem[] | null {
  if (!isRecord(input)) return null;
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const normalized: AskUserQuestionItem[] = [];
  for (const raw of questions) {
    if (!isRecord(raw)) return null;
    const { question, header, options: rawOptions, multiSelect } = raw;
    if (typeof question !== 'string' || question.trim().length === 0) return null;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

    const options: AskUserQuestionOption[] = [];
    for (const rawOption of rawOptions) {
      const option = normalizeOption(rawOption);
      if (!option) return null;
      options.push(option);
    }

    normalized.push({
      question,
      header: typeof header === 'string' ? header : '',
      options,
      ...(typeof multiSelect === 'boolean' ? { multiSelect } : {}),
    });
  }
  return normalized;
}

/**
 * Build the tool-result payload an agent returns for an answered
 * AskUserQuestion, mirroring the Claude Code SDK `AskUserQuestionOutput`
 * shape (`questions` echoed back plus the user's `answers`/`response`).
 */
export function buildAskUserQuestionResult(
  questions: AskUserQuestionItem[],
  response: AskUserQuestionResponse,
): { questions: AskUserQuestionItem[]; answers: Record<string, string>; response?: string } {
  return {
    questions,
    answers: response.answers ?? {},
    ...(response.response ? { response: response.response } : {}),
  };
}

/**
 * Tool description advertised to the Pi backend's model (Claude gets its
 * AskUserQuestion description from the SDK preset, so this is Pi-only).
 */
export const ASK_USER_QUESTION_TOOL_DESCRIPTION =
  'Ask the user one or more multiple-choice questions to clarify requirements or ' +
  'pick between approaches, then receive their selected answers. Use this ONLY when ' +
  'you genuinely need the user\'s input to proceed — never for confirmations you can ' +
  'reasonably infer. Provide 1-4 questions, each with 2-4 concise options (label + ' +
  'short description). The UI always adds a Skip control and a free-text field, so do ' +
  'NOT include "Other"/"None" options yourself. Prefer this tool over asking questions ' +
  'in plain prose.';

/**
 * JSON Schema for the AskUserQuestion tool input, registered with the Pi
 * subprocess so its model can call the tool. Mirrors the Claude Code SDK shape.
 */
export const ASK_USER_QUESTION_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'The questions to ask the user (1-4).',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The complete question to ask, ending with a question mark.',
          },
          header: {
            type: 'string',
            description: 'Very short label (<= 12 chars) shown as a chip, e.g. "Auth method".',
          },
          multiSelect: {
            type: 'boolean',
            description: 'Set true to let the user pick multiple options.',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            description: 'The 2-4 mutually exclusive choices (unless multiSelect).',
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description: 'Concise option text the user selects (1-5 words).',
                },
                description: {
                  type: 'string',
                  description: 'What choosing this option means or implies.',
                },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'header', 'options'],
      },
    },
  },
  required: ['questions'],
};
