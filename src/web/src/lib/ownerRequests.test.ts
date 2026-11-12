import { describe, expect, it } from 'vitest';
import { expiryText, resolutionTurnLabel, snoozeChoices } from './ownerRequests';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;

/** Byte for byte what `ownerRequestResolutionTurn` writes on the server. */
const turn = (state: string) => [
  `Orbit owner request 34uabc (MANUAL_STEP) ended ${state}: the owner did what was asked.`,
  '',
  'This turn was queued by Orbit when the request ended, not typed by a person. The request is final and will not wake this session again.',
  '',
  '```json',
  '{}',
  '```',
].join('\n');

describe('resolutionTurnLabel', () => {
  it('reads the turn the server queues, per ending', () => {
    expect(resolutionTurnLabel(turn('DONE'))).toBe('Owner action resolved · turn started automatically');
    expect(resolutionTurnLabel(turn('DECLINED'))).toBe('Owner declined the request · turn started automatically');
    expect(resolutionTurnLabel(turn('EXPIRED'))).toBe('Owner request expired · turn started automatically');
    expect(resolutionTurnLabel(turn('WITHDRAWN'))).toBe('Owner request withdrawn · turn started automatically');
  });

  it('leaves what a person typed alone', () => {
    expect(resolutionTurnLabel('Orbit owner request 34uabc (SECRET) ended DONE: looks wrong to me')).toBeNull();
    expect(resolutionTurnLabel('hello')).toBeNull();
  });
});

describe('deadlines', () => {
  it('says how long is left, and nothing when there is no deadline', () => {
    expect(expiryText({ expiresAt: new Date(NOW + 3 * 24 * HOUR).toISOString() }, NOW)).toBe('expires in 3d');
    expect(expiryText({ expiresAt: new Date(NOW - 1).toISOString() }, NOW)).toBe('expired');
    expect(expiryText({ expiresAt: null }, NOW)).toBeNull();
  });

  it('offers no reminder that would land after the deadline', () => {
    const keys = (hours: number | null) =>
      snoozeChoices({ expiresAt: hours === null ? null : new Date(NOW + hours * HOUR).toISOString() }, NOW).map((c) => c.key);
    expect(keys(null)).toEqual(['1h', '4h', '1d']);
    expect(keys(2)).toEqual(['1h']);
    expect(keys(0.5)).toEqual([]);
  });
});
