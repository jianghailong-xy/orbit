import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  dropAnchor,
  EMPTY_SELECTION,
  extendTo,
  selectAll,
  toggleOne,
  type Selection,
} from './taskSelection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const picked = (sel: Selection) => [...sel.ids].sort();

describe('toggleOne', () => {
  it('checks a row and anchors on it', () => {
    const sel = toggleOne(EMPTY_SELECTION, 'b');
    expect(picked(sel)).toEqual(['b']);
    expect(sel.anchor).toEqual({ id: 'b', mode: 'add' });
  });

  it('unchecks a checked row and anchors in the remove direction', () => {
    const sel = toggleOne(toggleOne(EMPTY_SELECTION, 'b'), 'b');
    expect(picked(sel)).toEqual([]);
    expect(sel.anchor).toEqual({ id: 'b', mode: 'remove' });
  });

  it('ends the Shift sequence so the next range starts from a fresh snapshot', () => {
    const shifted = extendTo(toggleOne(EMPTY_SELECTION, 'a'), 'c', ORDER);
    expect(shifted.base).not.toBeNull();
    expect(toggleOne(shifted, 'e').base).toBeNull();
  });
});

describe('extendTo', () => {
  it('selects the inclusive range between the anchor and the target', () => {
    const sel = extendTo(toggleOne(EMPTY_SELECTION, 'b'), 'd', ORDER);
    expect(picked(sel)).toEqual(['b', 'c', 'd']);
  });

  it('extends upward as well as downward', () => {
    const sel = extendTo(toggleOne(EMPTY_SELECTION, 'd'), 'b', ORDER);
    expect(picked(sel)).toEqual(['b', 'c', 'd']);
  });

  it('redraws rather than accumulates when the range is shrunk', () => {
    const wide = extendTo(toggleOne(EMPTY_SELECTION, 'a'), 'e', ORDER);
    expect(picked(wide)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const narrowed = extendTo(wide, 'b', ORDER);
    expect(picked(narrowed)).toEqual(['a', 'b']);
  });

  it('keeps rows checked before the Shift sequence began', () => {
    const withE = toggleOne(EMPTY_SELECTION, 'e');
    const sel = extendTo(toggleOne(withE, 'a'), 'b', ORDER);
    expect(picked(sel)).toEqual(['a', 'b', 'e']);
    // Re-drawing the range still leaves the pre-existing 'e' alone.
    expect(picked(extendTo(sel, 'a', ORDER))).toEqual(['a', 'e']);
  });

  it('clears the range when the anchor was an uncheck', () => {
    const all = selectAll(ORDER);
    const unchecked = toggleOne(all, 'b');
    const sel = extendTo(unchecked, 'd', ORDER);
    expect(picked(sel)).toEqual(['a', 'e']);
  });

  it('falls back to a plain toggle with no anchor', () => {
    const sel = extendTo(EMPTY_SELECTION, 'c', ORDER);
    expect(picked(sel)).toEqual(['c']);
    expect(sel.anchor).toEqual({ id: 'c', mode: 'add' });
  });

  it('falls back to a plain toggle when the anchor is no longer visible', () => {
    const stale = toggleOne(EMPTY_SELECTION, 'zz');
    const sel = extendTo(stale, 'c', ORDER);
    expect(picked(sel)).toEqual(['c', 'zz']);
    expect(sel.anchor).toEqual({ id: 'c', mode: 'add' });
  });

  it('does not mutate the snapshot it draws from', () => {
    const base = toggleOne(EMPTY_SELECTION, 'a');
    extendTo(base, 'd', ORDER);
    expect(picked(base)).toEqual(['a']);
  });
});

describe('anchorAt', () => {
  it('moves the anchor without changing the selection', () => {
    const sel = anchorAt(toggleOne(EMPTY_SELECTION, 'a'), 'd');
    expect(picked(sel)).toEqual(['a']);
    expect(sel.anchor).toEqual({ id: 'd', mode: 'add' });
  });

  it('lets a following Shift-extend grow from the cursor', () => {
    const sel = extendTo(anchorAt(EMPTY_SELECTION, 'c'), 'e', ORDER);
    expect(picked(sel)).toEqual(['c', 'd', 'e']);
  });
});

describe('dropAnchor', () => {
  it('keeps the selection but invalidates the range origin', () => {
    const sel = dropAnchor(extendTo(toggleOne(EMPTY_SELECTION, 'a'), 'c', ORDER));
    expect(picked(sel)).toEqual(['a', 'b', 'c']);
    expect(sel.anchor).toBeNull();
    expect(sel.base).toBeNull();
  });

  it('returns the same object when there is no anchor to drop', () => {
    expect(dropAnchor(EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });
});
