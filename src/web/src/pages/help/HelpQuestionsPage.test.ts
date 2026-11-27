import { describe, expect, it } from 'vitest';
import type { HelpAskRow } from '@orbit/shared';
import { questionLine } from './HelpQuestionsPage';

/** /help → Your questions (board 02 ④): an Ask sent to an admin reads "sent to <admin>", its state With your admin. */
describe('questionLine', () => {
  const NOW = new Date('2026-11-16T12:00:00');
  const row = (over: Partial<HelpAskRow>): HelpAskRow => ({
    id: 'a1',
    title: 'Can two people confirm the same task?',
    origin: 'a task',
    outcome: 'answered',
    createdAt: '2026-11-12T09:00:00',
    sentTo: null,
    ...over,
  });

  it('an answered Ask says answered', () => {
    expect(questionLine(row({}), NOW)).toBe('Nov 12 · from a task · answered');
  });

  it('an Ask sent to an admin says who it went to', () => {
    expect(questionLine(row({ outcome: 'with-admin', sentTo: 'Alex Li' }), NOW)).toBe('Nov 12 · from a task · sent to Alex Li');
  });
});
