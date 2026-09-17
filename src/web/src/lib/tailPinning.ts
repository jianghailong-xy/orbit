// Whether the transcript is still following its live tail. The macOS/iOS clients decide this with
// OrbitKit's `TailPinning` — same threshold, same three-part rule — and `TailPinningWiringTests`
// reads this file to keep the two from drifting.
//
// The gap under the viewport can't answer it alone: a long transcript replays as a flood of
// one-event-at-a-time renders and each programmatic scroll fires its scroll event asynchronously,
// by which time newer events have grown the container — so a position-only test reads a large gap
// and strands the reader above the bottom. Hence the rule: a small gap re-pins, and only a scroll UP
// un-pins.
//
// What that alone misses is content getting SHORTER under a pinned reader: a stretch of reasoning
// folds to its one-line summary the instant it settles, and a scrollTop the browser clamps to the
// new, smaller scrollHeight looks exactly like a reader dragging up. So the transcript stopped
// following a reply that was still being written, once in every turn that thinks.

/** Within this many px of the end still reads as pinned. */
export const NEAR_BOTTOM = 80;

/**
 * How long after a wheel, a finger, a scrollbar press or an arrow key a falling scrollTop still
 * counts as the reader's own. The browser reports no scroll phase (SwiftUI's `ScrollPhase` is what
 * the clients read), so the input events are the only evidence of intent there is.
 */
export const READER_INPUT_GRACE_MS = 400;

export type TailScrollSample = {
  /** scrollTop */
  offset: number;
  /** scrollHeight */
  contentHeight: number;
  /** scrollHeight - scrollTop - clientHeight. Zero at the live tail. */
  bottomGap: number;
};

/** Nothing measured yet — a freshly opened or switched session, before its first scroll event. */
export const TAIL_SAMPLE_ZERO: TailScrollSample = { offset: 0, contentHeight: 0, bottomGap: 0 };

export function sampleTail(el: HTMLElement): TailScrollSample {
  return {
    offset: el.scrollTop,
    contentHeight: el.scrollHeight,
    bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight,
  };
}

/**
 * The pinned state `current` implies, given the sample before it.
 *
 * `readerDriven` is whether the reader was the one moving the scroller. A scrollTop that falls
 * without them, while the content resized in the same breath, is the clamp — not a scroll up. The
 * height test can't carry the case by itself, because content moves on nearly every frame of a
 * streaming reply and a drag up during one has to keep winning; and it still has to un-pin a fall
 * over unchanged content, which is a jump back to an earlier question.
 */
export function pinnedToTail(
  wasPinned: boolean,
  previous: TailScrollSample,
  current: TailScrollSample,
  readerDriven: boolean,
): boolean {
  if (current.bottomGap <= NEAR_BOTTOM) return true;
  const resized = current.contentHeight !== previous.contentHeight;
  if (current.offset < previous.offset - 1 && (readerDriven || !resized)) return false;
  return wasPinned;
}
