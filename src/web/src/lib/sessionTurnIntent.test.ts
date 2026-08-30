import { describe, expect, it } from 'vitest';
import { defaultSessionTurnIntent } from './sessionTurnIntent';

describe('composer default send intent', () => {
  it.each([
    [{ live: true, status: 'RUNNING', numTurns: 4 }, 'CURRENT_WORK'],
    [{ live: true, status: 'PENDING', numTurns: 0 }, 'CURRENT_WORK'],
    [{ live: true, status: 'PENDING', numTurns: 1 }, 'NEXT_TURN'],
    [{ live: true, status: 'AWAITING_INPUT', numTurns: 4 }, 'NEXT_TURN'],
    [{ live: false, status: 'RUNNING', numTurns: 4 }, 'NEXT_TURN'],
    [{ live: false, status: null, numTurns: 0 }, 'NEXT_TURN'],
  ] as const)('maps %o to %s', (input, expected) => {
    expect(defaultSessionTurnIntent(input)).toBe(expected);
  });
});
