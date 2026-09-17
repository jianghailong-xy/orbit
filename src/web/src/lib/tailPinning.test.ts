import { describe, expect, it } from 'vitest';
import { pinnedToTail, type TailScrollSample } from './tailPinning';

// The same nine cases OrbitKit's TailPinningTests carries, in the same order: a ~700px viewport
// over 4000px of transcript, with the reader at the very end.
const atTail: TailScrollSample = { offset: 3300, contentHeight: 4000, bottomGap: 0 };

const pinned = (
  current: TailScrollSample,
  { previous = atTail, readerDriven = false, wasPinned = true } = {},
): boolean => pinnedToTail(wasPinned, previous, current, readerDriven);

describe('a settled stretch of reasoning folds to its summary', () => {
  it('cannot un-pin the tail', () => {
    // The live draft (~180px of self-scrolling reasoning) becomes a one-line row, so the browser
    // clamps scrollTop by what the container lost. The sample still carries the pre-fold gap —
    // the same signature a reader dragging up leaves.
    expect(pinned({ offset: 3120, contentHeight: 3820, bottomGap: 180 })).toBe(true);
  });

  it('cannot un-pin it when the fold and the next row land together', () => {
    // Net TALLER even though scrollTop was clamped down: a height comparison alone would read
    // this as a reader scrolling up.
    expect(pinned({ offset: 3120, contentHeight: 4260, bottomGap: 620 })).toBe(true);
  });

  it('cannot un-pin it while the fold is still collapsing', () => {
    expect(pinned({ offset: 3200, contentHeight: 3900, bottomGap: 100 })).toBe(true);
  });
});

describe('what the rule has to keep doing', () => {
  it('un-pins when the reader drags up', () => {
    expect(
      pinned({ offset: 2500, contentHeight: 4000, bottomGap: 800 }, { readerDriven: true }),
    ).toBe(false);
  });

  it('still un-pins when they drag up while the reply streams', () => {
    // Streaming moves scrollHeight on nearly every frame; the reader must still win, or reading
    // history during a reply would be impossible.
    expect(
      pinned({ offset: 2500, contentHeight: 4400, bottomGap: 1200 }, { readerDriven: true }),
    ).toBe(false);
  });

  it('un-pins on a jump back to an earlier question', () => {
    // The sticky prompt bar scrolls up over unchanged content — no reader input behind it.
    expect(pinned({ offset: 1200, contentHeight: 4000, bottomGap: 2100 })).toBe(false);
  });

  it('keeps a pinned reader pinned when rows are appended below them', () => {
    // The gap alone is what a position-only test trips over: the rows are laid out and the
    // follow-on scroll is still a frame away.
    expect(pinned({ offset: 3300, contentHeight: 4600, bottomGap: 600 })).toBe(true);
  });

  it('re-pins on the way back to the end', () => {
    expect(
      pinned(
        { offset: 3260, contentHeight: 4000, bottomGap: 40 },
        {
          previous: { offset: 2500, contentHeight: 4000, bottomGap: 800 },
          readerDriven: true,
          wasPinned: false,
        },
      ),
    ).toBe(true);
  });

  it('treats the end itself as pinned even while the reader drags upward inside the slack', () => {
    expect(
      pinned({ offset: 3240, contentHeight: 4000, bottomGap: 60 }, { readerDriven: true }),
    ).toBe(true);
  });
});
