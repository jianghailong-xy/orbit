import { describe, expect, it } from 'vitest';
import {
  dragOffset,
  isFullSwipe,
  restingOffset,
  sessionSwipeActions,
  settleSwipe,
  swipeGeometry,
} from './sessionSwipe';

// A 400px phone row. Open reveals two leading actions (144px) and one trailing (72px); a full swipe
// is armed at 60% of the row (240px).
const ROW = 400;
const open = swipeGeometry('open', ROW, true);

describe('sessionSwipeActions', () => {
  // Hand-synced with `SessionRowActions.swift`: leading = positive actions (outermost first, the
  // full-swipe one leads), trailing = Delete.
  it('lays each list out like the iOS row', () => {
    expect(sessionSwipeActions('open')).toEqual({ leading: ['complete', 'pin'], trailing: ['delete'] });
    expect(sessionSwipeActions('completed')).toEqual({
      leading: ['restore', 'pin'],
      trailing: ['delete'],
    });
    expect(sessionSwipeActions('trash')).toEqual({ leading: ['restore'], trailing: ['purge'] });
  });
});

describe('settleSwipe', () => {
  it('opens the side a closed row was dragged to once half of it shows', () => {
    expect(settleSwipe(null, dragOffset(null, 71, open), open)).toEqual({ open: null, fullSwipe: false });
    expect(settleSwipe(null, dragOffset(null, 72, open), open)).toEqual({
      open: 'leading',
      fullSwipe: false,
    });
    expect(settleSwipe(null, dragOffset(null, -35, open), open).open).toBeNull();
    expect(settleSwipe(null, dragOffset(null, -36, open), open).open).toBe('trailing');
  });

  it('keeps an open side through a small drag back and shuts it past the slop', () => {
    expect(settleSwipe('leading', dragOffset('leading', -16, open), open).open).toBe('leading');
    expect(settleSwipe('leading', dragOffset('leading', -17, open), open).open).toBeNull();
    expect(settleSwipe('trailing', dragOffset('trailing', 16, open), open).open).toBe('trailing');
    expect(settleSwipe('trailing', dragOffset('trailing', 17, open), open).open).toBeNull();
  });

  it('carries one drag from an open side through to the other', () => {
    const offset = dragOffset('leading', -200, open);
    expect(offset).toBe(-56);
    expect(settleSwipe('leading', offset, open).open).toBe('trailing');
  });

  it('performs the first leading action on a release past 60% of the row, and closes', () => {
    expect(isFullSwipe(dragOffset(null, 239, open), open)).toBe(false);
    expect(settleSwipe(null, dragOffset(null, 239, open), open)).toEqual({
      open: 'leading',
      fullSwipe: false,
    });
    expect(settleSwipe(null, dragOffset(null, 240, open), open)).toEqual({
      open: null,
      fullSwipe: true,
    });
    // Dragged past the mark and back under it: no longer a full swipe.
    expect(settleSwipe('leading', dragOffset('leading', 95, open), open).fullSwipe).toBe(false);
  });

  it('cannot full swipe while the first action is unavailable', () => {
    const blocked = swipeGeometry('open', ROW, false);
    const offset = dragOffset(null, 390, blocked);
    expect(offset).toBe(164); // stops just past the revealed actions
    expect(settleSwipe(null, offset, blocked)).toEqual({ open: 'leading', fullSwipe: false });
  });

  it('never turns a long leftward drag into Delete', () => {
    const offset = dragOffset(null, -390, open);
    expect(offset).toBe(-92);
    expect(settleSwipe(null, offset, open)).toEqual({ open: 'trailing', fullSwipe: false });
  });

  it('rests Trash rows on its single-action edges', () => {
    const trash = swipeGeometry('trash', ROW, true);
    expect(restingOffset('leading', trash)).toBe(72);
    expect(restingOffset('trailing', trash)).toBe(-72);
    expect(settleSwipe(null, dragOffset(null, 36, trash), trash).open).toBe('leading');
  });
});
