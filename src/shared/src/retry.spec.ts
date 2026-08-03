import { describe, expect, it } from 'vitest';
import { lastUserMessageText, parseQuotaResetAt } from './retry';

describe('lastUserMessageText', () => {
  it('uses the latest emitted user message', () => {
    expect(
      lastUserMessageText([
        { type: 'user', payload: { text: 'first' } },
        { type: 'assistant', payload: { text: 'reply' } },
        { type: 'user', payload: { text: 'retry this' } },
      ]),
    ).toBe('retry this');
  });

  it('falls back to the opening prompt when the first run fails before any user event', () => {
    expect(lastUserMessageText([{ type: 'error', payload: {} }], 'original prompt', 0)).toBe(
      'original prompt',
    );
  });

  it('does not mistake the opening prompt for the latest message of an established session', () => {
    expect(lastUserMessageText([{ type: 'error', payload: {} }], 'old opening prompt', 2)).toBe('');
  });
});

describe('parseQuotaResetAt', () => {
  // The real incident: session 019fc863 hit its limit at 16:09:33Z and came back at 16:20Z
  // (6:20 PM in Berlin, CEST = UTC+2).
  it('reads the 5-hour session limit off Claude Code’s own message', () => {
    expect(
      parseQuotaResetAt(
        "You've hit your session limit · resets 6:20pm (Europe/Berlin)",
        new Date('2026-08-03T16:09:33Z'),
      ),
    ).toEqual(new Date('2026-08-03T16:20:00Z'));
  });

  it('treats a bare time that already passed today as tomorrow', () => {
    // 18:09 in Berlin; 1 PM is behind us, so the weekly window reopens tomorrow.
    expect(
      parseQuotaResetAt(
        "You've hit your weekly limit · resets 1pm (Europe/Berlin)",
        new Date('2026-08-03T16:09:00Z'),
      ),
    ).toEqual(new Date('2026-08-04T11:00:00Z'));
  });

  it('uses the printed date when the reset is not today', () => {
    expect(
      parseQuotaResetAt(
        "You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)",
        new Date('2026-07-30T09:00:00Z'),
      ),
    ).toEqual(new Date('2026-08-03T11:00:00Z'));
  });

  it('rolls a printed date that already passed into next year', () => {
    expect(
      parseQuotaResetAt('resets Jan 2, 9am (America/New_York)', new Date('2026-12-31T18:00:00Z')),
    ).toEqual(new Date('2027-01-02T14:00:00Z'));
  });

  it('handles midnight and noon', () => {
    const now = new Date('2026-08-03T16:00:00Z'); // 18:00 Berlin
    expect(parseQuotaResetAt('resets 12am (Europe/Berlin)', now)).toEqual(
      new Date('2026-08-03T22:00:00Z'), // 00:00 Berlin, tomorrow
    );
    expect(parseQuotaResetAt('resets 12pm (Europe/Berlin)', now)).toEqual(
      new Date('2026-08-04T10:00:00Z'), // noon already passed today
    );
  });

  it('resolves a wall-clock time across a DST transition', () => {
    // Europe/Berlin leaves DST at 03:00 local on 2026-10-25; 6:20 PM that day is UTC+1.
    expect(
      parseQuotaResetAt('resets 6:20pm (Europe/Berlin)', new Date('2026-10-25T10:00:00Z')),
    ).toEqual(new Date('2026-10-25T17:20:00Z'));
  });

  it('returns null for Codex’s phrasing, which names no time zone', () => {
    expect(
      parseQuotaResetAt(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to " +
          'purchase more credits or try again at Aug 9th, 2026 1:26 PM.',
        new Date('2026-08-03T16:00:00Z'),
      ),
    ).toBeNull();
  });

  it('returns null for an unknown zone, a bad hour, and unrelated text', () => {
    const now = new Date('2026-08-03T16:00:00Z');
    expect(parseQuotaResetAt('resets 6:20pm (Mars/Olympus)', now)).toBeNull();
    expect(parseQuotaResetAt('resets 19:20pm (Europe/Berlin)', now)).toBeNull();
    expect(parseQuotaResetAt('the build resets the cache', now)).toBeNull();
    expect(parseQuotaResetAt(null, now)).toBeNull();
  });
});
