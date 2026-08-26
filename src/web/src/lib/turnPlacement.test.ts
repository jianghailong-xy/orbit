import { describe, expect, it } from 'vitest';
import { turnPlacementOf } from './turnPlacement';

describe('turn placement returned by send', () => {
  it('trusts the row-locked server decision over a stale local idle snapshot', () => {
    expect(turnPlacementOf({ placement: 'queued', kind: 'message' }, true)).toBe('queued');
    expect(turnPlacementOf({ placement: 'accepted', kind: 'message' }, false)).toBe(
      'accepted',
    );
    expect(turnPlacementOf({ placement: 'steer', kind: 'steer' }, true)).toBe('steer');
  });

  it('keeps the old idle/kind fallback during a rolling upgrade', () => {
    expect(turnPlacementOf({ kind: 'message' }, true)).toBe('accepted');
    expect(turnPlacementOf({ kind: 'shell' }, false)).toBe('queued');
    expect(turnPlacementOf({ kind: 'steer' }, true)).toBe('steer');
  });
});
