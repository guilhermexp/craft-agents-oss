/**
 * Tests for the interactive AskUserQuestion plumbing:
 * - validateAskUserQuestions (input validation + normalization)
 * - buildAskUserQuestionResult (tool-result shaping)
 * - BaseAgent parking round-trip (await -> respond / clear / timeout)
 */
import { describe, it, expect } from 'bun:test';
import {
  validateAskUserQuestions,
  buildAskUserQuestionResult,
  buildAskUserQuestionHookOutput,
  normalizeAskUserQuestionResponse,
  ASK_USER_QUESTION_TIMEOUT_MS,
} from '../ask-user-question.ts';
import type { AskUserQuestionResponse } from '@craft-agent/core/types';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

describe('validateAskUserQuestions', () => {
  it('accepts a well-formed questionnaire and normalizes fields', () => {
    const result = validateAskUserQuestions({
      questions: [
        {
          question: 'Pick one?',
          header: 'Choice',
          options: [{ label: 'A', description: 'first' }, { label: 'B' }],
          multiSelect: true,
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.question).toBe('Pick one?');
    expect(result![0]!.multiSelect).toBe(true);
    expect(result![0]!.options.map(o => o.label)).toEqual(['A', 'B']);
    // Options without a description drop the field rather than carry undefined text.
    expect(result![0]!.options[1]!.description).toBeUndefined();
  });

  it('rejects malformed payloads', () => {
    expect(validateAskUserQuestions(null)).toBeNull();
    expect(validateAskUserQuestions({})).toBeNull();
    expect(validateAskUserQuestions({ questions: [] })).toBeNull();
    // Missing question text
    expect(validateAskUserQuestions({ questions: [{ header: 'x', options: [{ label: 'A' }] }] })).toBeNull();
    // No options
    expect(validateAskUserQuestions({ questions: [{ question: 'q', options: [] }] })).toBeNull();
    // Option without a label
    expect(validateAskUserQuestions({ questions: [{ question: 'q', options: [{ description: 'no label' }] }] })).toBeNull();
  });

  it('rejects duplicate question text in the same questionnaire', () => {
    expect(validateAskUserQuestions({
      questions: [
        { question: 'Same question?', header: 'First', options: [{ label: 'A' }] },
        { question: 'Same question?', header: 'Second', options: [{ label: 'B' }] },
      ],
    })).toBeNull();
  });
});

describe('buildAskUserQuestionResult', () => {
  const questions = validateAskUserQuestions({
    questions: [{ question: 'q?', header: 'h', options: [{ label: 'A' }, { label: 'B' }] }],
  })!;

  it('echoes questions and answers, omitting an empty response', () => {
    const result = buildAskUserQuestionResult(questions, { answers: { 'q?': 'A' } });
    expect(result.questions).toEqual(questions);
    expect(result.answers).toEqual({ 'q?': 'A' });
    expect('response' in result).toBe(false);
  });

  it('includes the freeform response when present', () => {
    const result = buildAskUserQuestionResult(questions, { answers: {}, response: 'custom' });
    expect(result.response).toBe('custom');
  });

  it('preserves a skipped response in the tool result', () => {
    const result = buildAskUserQuestionResult(questions, { answers: {}, skipped: true });
    expect(result).toEqual({
      questions,
      answers: {},
      skipped: true,
    });
  });
});

describe('buildAskUserQuestionHookOutput', () => {
  const questions = validateAskUserQuestions({
    questions: [{ question: 'q?', header: 'h', options: [{ label: 'A' }, { label: 'B' }] }],
  })!;

  // Without the explicit allow the CLI discards updatedInput and runs its own
  // AskUserQuestion on the model's original input, so the model reads
  // "The user did not answer the questions." however the user answered.
  it('claims the permission decision so the CLI honors updatedInput', () => {
    const output = buildAskUserQuestionHookOutput(questions, { answers: { 'q?': 'A' } });
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.continue).toBe(true);
  });

  it('sends only schema fields, echoing the questions with the answers', () => {
    const { updatedInput } = buildAskUserQuestionHookOutput(questions, {
      answers: { 'q?': 'A, B' },
    }).hookSpecificOutput;
    expect(updatedInput).toEqual({ questions, answers: { 'q?': 'A, B' } });
  });

  it('forwards the freeform response, which the CLI renders over the answers', () => {
    const { updatedInput } = buildAskUserQuestionHookOutput(questions, {
      answers: {},
      response: 'timed out',
    }).hookSpecificOutput;
    expect(updatedInput.response).toBe('timed out');
  });

  // `skipped` is Craft-internal; an empty answers map is what tells the model
  // nobody answered, and an unknown key would risk the CLI's schema validation.
  it('drops the Craft-internal skipped flag', () => {
    const { updatedInput } = buildAskUserQuestionHookOutput(questions, {
      answers: {},
      skipped: true,
    }).hookSpecificOutput;
    expect(updatedInput).toEqual({ questions, answers: {} });
  });
});

describe('normalizeAskUserQuestionResponse', () => {
  it('turns null into a skipped response', () => {
    expect(normalizeAskUserQuestionResponse(null)).toEqual({ answers: {}, skipped: true });
  });

  it('preserves a valid answered response', () => {
    expect(normalizeAskUserQuestionResponse({
      answers: { 'Pick one?': 'A' },
      response: 'A',
    })).toEqual({
      answers: { 'Pick one?': 'A' },
      response: 'A',
    });
  });

  it('preserves an explicit skipped response', () => {
    expect(normalizeAskUserQuestionResponse({ answers: {}, skipped: true })).toEqual({
      answers: {},
      skipped: true,
    });
  });
});

/** Exposes the protected parking helpers for round-trip assertions. */
class QuestionAgent extends TestAgent {
  askNow(id: string, timeoutMs: number = ASK_USER_QUESTION_TIMEOUT_MS): Promise<AskUserQuestionResponse> {
    return this.awaitUserQuestion(id, timeoutMs);
  }
  clearNow(reason?: string): void {
    this.clearPendingUserQuestions(reason);
  }
}

describe('BaseAgent AskUserQuestion round-trip', () => {
  it('resolves the parked question with the delivered answer', async () => {
    const agent = new QuestionAgent(createMockBackendConfig());
    const pending = agent.askNow('tool-1');
    const delivered = agent.respondToUserQuestion('tool-1', { answers: { q: 'A' } });
    expect(delivered).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { q: 'A' } });
    expect(agent.respondToUserQuestion('tool-1', { answers: { q: 'B' } })).toBe(false);
  });

  it('returns false when there is no pending question for the id', () => {
    const agent = new QuestionAgent(createMockBackendConfig());
    expect(agent.respondToUserQuestion('missing', { answers: {} })).toBe(false);
  });

  it('resolves parked questions as skipped when cleared', async () => {
    const agent = new QuestionAgent(createMockBackendConfig());
    const pending = agent.askNow('tool-2');
    agent.clearNow('the turn was aborted');
    const result = await pending;
    expect(result.skipped).toBe(true);
    expect(result.answers).toEqual({});
  });

  it('auto-skips after the timeout elapses', async () => {
    const agent = new QuestionAgent(createMockBackendConfig());
    const result = await agent.askNow('tool-3', 5);
    expect(result.skipped).toBe(true);
  });
});
