import { describe, expect, it } from 'vitest';
import type { SessionGuestSuggestion } from '@orbit/shared';
import { lastInvitedLabel, matchGuestSuggestions } from './guestSuggestions';

const person = (name: string, email: string): SessionGuestSuggestion => ({
  name, email, lastInvitedAt: '2026-11-13T02:00:00.000Z',
});
const PEOPLE = [
  person('Alice Chen', 'alice@example.com'),
  person('Paula Ortiz', 'paula.ortiz@example.com'),
  person('Sam Wu', 'sam@example.org'),
  person('Pat Lee', 'patlee@example.net'),
  person('Lin Wei', 'lw@spa.example'),
  person('Zoe Park', 'zoe@example.com'),
];

describe('matchGuestSuggestions', () => {
  it('suggests the newest five while the field is empty', () => {
    expect(matchGuestSuggestions(PEOPLE, '  ').map((m) => m.person.name)).toEqual([
      'Alice Chen', 'Paula Ortiz', 'Sam Wu', 'Pat Lee', 'Lin Wei',
    ]);
  });

  it('keeps people whose name or email has a word starting with what is typed, and marks it', () => {
    const matches = matchGuestSuggestions(PEOPLE, 'Pa');
    expect(matches.map((m) => [m.person.name, m.name, m.email])).toEqual([
      ['Paula Ortiz', [0, 2], [0, 2]],
      ['Pat Lee', [0, 2], [0, 2]],
      ['Zoe Park', [4, 6], null],
    ]);
    // A word inside the email, after @ . _ + or -: "spa" is not a word start, "ortiz" is.
    expect(matchGuestSuggestions(PEOPLE, 'ortiz').map((m) => [m.person.name, m.email])).toEqual([
      ['Paula Ortiz', [6, 11]],
    ]);
    expect(matchGuestSuggestions(PEOPLE, 'pa').some((m) => m.person.name === 'Lin Wei')).toBe(false);
  });

  it('suggests nobody once the field holds one of their emails exactly, or nothing matches', () => {
    expect(matchGuestSuggestions(PEOPLE, 'Paula.Ortiz@example.com')).toEqual([]);
    expect(matchGuestSuggestions(PEOPLE, 'bob')).toEqual([]);
  });
});

describe('lastInvitedLabel', () => {
  it('says Today for today, else the month and day', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    expect(lastInvitedLabel(new Date(2026, 10, 16, 9, 30).toISOString(), now)).toBe('Today');
    expect(lastInvitedLabel(new Date(2026, 10, 13, 9, 30).toISOString(), now)).toBe('Nov 13');
  });
});
