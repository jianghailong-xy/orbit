import { describe, expect, it } from 'vitest';
import { turnPlacementOf } from './turnPlacement';

describe('authoritative server turn placement', () => {
  it('accepts every protocol placement, including startup context', () => {
    for (const placement of ['accepted', 'startup', 'queued', 'steer'] as const) {
      expect(turnPlacementOf({ placement })).toBe(placement);
    }
  });

  it('rejects missing or unknown placement instead of guessing from local state', () => {
    expect(() => turnPlacementOf({} as never)).toThrow(/server placement/i);
    expect(() => turnPlacementOf({ placement: 'message' } as never)).toThrow(/server placement/i);
  });
});
