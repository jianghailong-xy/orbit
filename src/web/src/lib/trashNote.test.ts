import { describe, expect, it } from 'vitest';
import { trashNoteWhen } from './trashNote';

const NOW = Date.parse('2026-11-03T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe('the words after In Trash', () => {
  it('says what holds a session, whatever its date says', () => {
    for (const deletedAt of [daysAgo(1), daysAgo(29.5), daysAgo(45), daysAgo(400)]) {
      expect(trashNoteWhen(deletedAt, 'PINNED_FILE', NOW)).toBe(' · kept while a file in it is pinned');
      expect(trashNoteWhen(deletedAt, 'CITED_FILE', NOW)).toBe(' · kept while evidence cites a file in it');
    }
  });

  it('never promises a deletion of a session a file is holding', () => {
    for (const hold of ['PINNED_FILE', 'CITED_FILE'] as const) {
      const note = trashNoteWhen(daysAgo(45), hold, NOW);
      expect(note).not.toMatch(/delete/i);
    }
  });

  it('counts the days of a session nothing holds', () => {
    expect(trashNoteWhen(daysAgo(0), null, NOW)).toBe(' · auto-deletes in 30 days');
    expect(trashNoteWhen(daysAgo(29), null, NOW)).toBe(' · auto-deletes in 1 day');
    expect(trashNoteWhen(daysAgo(29.5), null, NOW)).toBe(' · auto-deletes in 1 day');
    expect(trashNoteWhen(daysAgo(30), null, NOW)).toBe(' · deletes soon');
    expect(trashNoteWhen(daysAgo(45), null, NOW)).toBe(' · deletes soon');
  });

  it('reads a server that sends no hold as it always did', () => {
    expect(trashNoteWhen(daysAgo(29), undefined, NOW)).toBe(' · auto-deletes in 1 day');
    expect(trashNoteWhen(daysAgo(45), undefined, NOW)).toBe(' · deletes soon');
  });

  it('says nothing of a row with no date', () => {
    expect(trashNoteWhen(null, null, NOW)).toBe('');
    expect(trashNoteWhen(undefined, undefined, NOW)).toBe('');
  });
});
