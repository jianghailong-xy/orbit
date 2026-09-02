import { describe, expect, it } from 'vitest';
import { turnPlacementOf } from './turnPlacement';

describe('authoritative server turn placement', () => {
  it('accepts every protocol placement', () => {
    for (const placement of ['accepted', 'queued', 'steer'] as const) {
      expect(turnPlacementOf({ placement })).toBe(placement);
    }
  });

  it('rejects missing or unknown placement instead of guessing from local state', () => {
    expect(() => turnPlacementOf({} as never)).toThrow(/server placement/i);
    expect(() => turnPlacementOf({ placement: 'message' } as never)).toThrow(/server placement/i);
    // 0225 removed startup context; a replica still answering with it is a version skew, not a
    // placement to render.
    expect(() => turnPlacementOf({ placement: 'startup' } as never)).toThrow(/server placement/i);
  });
});
