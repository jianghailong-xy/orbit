import type { SessionListView } from './queries';

// Touch swipe actions on a session row, laid out the way the iOS list lays them out
// (`SessionRowActions.swift`): a rightward swipe reveals the positive actions on the leading edge,
// a leftward one reveals Delete on the trailing edge. Pure, so a gesture's outcome is testable
// without mounting the workspace.

export type SwipeSide = 'leading' | 'trailing';
export type SwipeAction = 'complete' | 'restore' | 'pin' | 'delete' | 'purge';

/** Width of one revealed action button (px). */
export const SWIPE_ACTION_WIDTH = 72;
/** How far past a fully revealed edge the row still follows the finger (px). */
const OVERDRAG = 20;
/** Dragging an open edge back toward closed by more than this (px) shuts it. */
const CLOSE_SLOP = 16;
/** Share of the row's width a rightward drag must pass for its release to be a full swipe. */
const FULL_SWIPE_FRACTION = 0.6;

/**
 * The actions each edge reveals, outermost first. As on iOS: a full swipe performs the first
 * leading action, Pin rides along everywhere but Trash, and Delete is never a full swipe — in Trash
 * it is the permanent purge.
 */
export function sessionSwipeActions(view: SessionListView): Record<SwipeSide, SwipeAction[]> {
  if (view === 'trash') return { leading: ['restore'], trailing: ['purge'] };
  return { leading: [view === 'completed' ? 'restore' : 'complete', 'pin'], trailing: ['delete'] };
}

export interface SwipeWidths {
  leadingWidth: number;
  trailingWidth: number;
}

export interface SwipeGeometry extends SwipeWidths {
  /** Offset at or past which releasing performs the first leading action; null when it can't run. */
  fullSwipeAt: number | null;
  /** Furthest the content may slide right. */
  maxOffset: number;
}

export function swipeWidths(view: SessionListView): SwipeWidths {
  const { leading, trailing } = sessionSwipeActions(view);
  return {
    leadingWidth: leading.length * SWIPE_ACTION_WIDTH,
    trailingWidth: trailing.length * SWIPE_ACTION_WIDTH,
  };
}

/** `canFullSwipe` is whether the first leading action (Complete / Move to Open) can run now. */
export function swipeGeometry(
  view: SessionListView,
  rowWidth: number,
  canFullSwipe: boolean,
): SwipeGeometry {
  const widths = swipeWidths(view);
  return {
    ...widths,
    fullSwipeAt: canFullSwipe ? rowWidth * FULL_SWIPE_FRACTION : null,
    maxOffset: canFullSwipe ? rowWidth : widths.leadingWidth + OVERDRAG,
  };
}

/** Where a row's content rests (px; positive = slid right) with `side` held open. */
export function restingOffset(side: SwipeSide | null, w: SwipeWidths): number {
  return side === 'leading' ? w.leadingWidth : side === 'trailing' ? -w.trailingWidth : 0;
}

/** The content's offset while a finger that went down with `from` open has moved `mx` px. */
export function dragOffset(from: SwipeSide | null, mx: number, g: SwipeGeometry): number {
  return Math.max(-(g.trailingWidth + OVERDRAG), Math.min(g.maxOffset, restingOffset(from, g) + mx));
}

export function isFullSwipe(offset: number, g: SwipeGeometry): boolean {
  return g.fullSwipeAt !== null && offset >= g.fullSwipeAt;
}

/**
 * What a release at `offset` does. Past the full-swipe mark it performs the first leading action
 * and closes. Otherwise the side the content sits on opens once it is half revealed — or, when that
 * side was already open, stays open unless dragged back by more than a small slop.
 */
export function settleSwipe(
  from: SwipeSide | null,
  offset: number,
  g: SwipeGeometry,
): { open: SwipeSide | null; fullSwipe: boolean } {
  if (isFullSwipe(offset, g)) return { open: null, fullSwipe: true };
  const side: SwipeSide | null = offset > 0 ? 'leading' : offset < 0 ? 'trailing' : null;
  if (!side) return { open: null, fullSwipe: false };
  const width = side === 'leading' ? g.leadingWidth : g.trailingWidth;
  const needed = from === side ? width - CLOSE_SLOP : width / 2;
  return { open: Math.abs(offset) >= needed ? side : null, fullSwipe: false };
}
