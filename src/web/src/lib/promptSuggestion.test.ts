import { describe, expect, it } from 'vitest';
import { currentPromptSuggestion, offeredPromptSuggestion, type PromptSuggestionGate } from './promptSuggestion';

const user = { type: 'user', payload: { text: 'fix the bug' } };
const turnEnd = { type: 'turn_end', payload: { subtype: 'success' } };
const suggestion = (text: unknown) => ({ type: 'prompt_suggestion', payload: { text } });

describe('currentPromptSuggestion', () => {
  it('offers the suggestion that followed the last turn', () => {
    expect(currentPromptSuggestion([user, { type: 'assistant' }, turnEnd, suggestion(' run the tests ')])).toBe(
      'run the tests',
    );
  });

  it('ignores events that say nothing about whose turn it is', () => {
    expect(
      currentPromptSuggestion([user, turnEnd, suggestion('run the tests'), { type: 'user_delivery' }, { type: 'system' }]),
    ).toBe('run the tests');
  });

  it('drops it once anything was said after it — on any device', () => {
    expect(currentPromptSuggestion([turnEnd, suggestion('run the tests'), user])).toBeNull();
  });

  it('drops it once a newer turn ended, including one the engine started itself', () => {
    expect(currentPromptSuggestion([turnEnd, suggestion('run the tests'), { type: 'assistant' }, turnEnd])).toBeNull();
  });

  it('has nothing to offer before any suggestion, or for an empty one', () => {
    expect(currentPromptSuggestion([])).toBeNull();
    expect(currentPromptSuggestion([user, turnEnd])).toBeNull();
    expect(currentPromptSuggestion([turnEnd, suggestion('  ')])).toBeNull();
    expect(currentPromptSuggestion([turnEnd, suggestion(42)])).toBeNull();
  });
});

describe('offeredPromptSuggestion', () => {
  const open: PromptSuggestionGate = {
    idle: true,
    draftEmpty: true,
    replying: false,
    pendingApprovals: 0,
    waitingKind: null,
    sendable: true,
    failed: false,
  };

  it('offers it in an idle, empty composer', () => {
    expect(offeredPromptSuggestion('run the tests', open)).toBe('run the tests');
  });

  it.each([
    ['a turn is running', { idle: false }],
    ['something is typed or staged', { draftEmpty: false }],
    ['a reply to a question is armed', { replying: true }],
    ['a card waits on an approval', { pendingApprovals: 1 }],
    ['an owner item waits on the person', { waitingKind: 'OWNER_ITEM' }],
    ['the conversation cannot take a message', { sendable: false }],
    ['the run failed', { failed: true }],
  ] as const)('holds it back while %s', (_why, change) => {
    expect(offeredPromptSuggestion('run the tests', { ...open, ...change })).toBeNull();
  });

  it('has nothing to offer without a suggestion', () => {
    expect(offeredPromptSuggestion(null, open)).toBeNull();
  });
});
