import { useSyncExternalStore } from 'react';
import {
  EMPTY_FEED,
  dismiss,
  dwellOf,
  expire,
  fold,
  levelOf,
  post,
  unfold,
  type ToastFeed,
  type ToastItem,
} from './toastFeed';

/**
 * The one feed every toast goes into (`lib/toast.tsx` posts, `components/ToastViewport.tsx` draws),
 * with the timers that take passing toasts down and fold an open pinned card on a phone. A module
 * singleton, like AntD's message holder was: a toast outlives the page that raised it.
 */

let feed: ToastFeed = EMPTY_FEED;
const listeners = new Set<() => void>();
const dwells = new Map<string, ReturnType<typeof setTimeout>>();
let folding: ReturnType<typeof setTimeout> | null = null;
let held = false;
let seq = 0;

function set(next: ToastFeed): void {
  if (next === feed) return;
  feed = next;
  for (const id of [...dwells.keys()]) {
    if (!feed.transient.some((one) => one.id === id)) stopDwell(id);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ToastFeed {
  return feed;
}

export function useToastFeed(): ToastFeed {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function stopDwell(id: string): void {
  const timer = dwells.get(id);
  if (timer !== undefined) clearTimeout(timer);
  dwells.delete(id);
}

function startDwell(toast: ToastItem): void {
  stopDwell(toast.id);
  const seconds = dwellOf(toast);
  if (seconds === null || held) return;
  dwells.set(
    toast.id,
    setTimeout(() => {
      dwells.delete(toast.id);
      set(expire(feed, toast.id));
    }, seconds * 1000),
  );
}

/** On a phone an open pinned card folds into its pill after six seconds: it stops covering the top of
 *  the page and stays one tap away. The wide stack draws every pinned card open regardless. */
function foldLater(id: string): void {
  if (folding !== null) clearTimeout(folding);
  folding = setTimeout(() => {
    folding = null;
    set(fold(feed, id));
  }, 6000);
}

/** Puts a toast up; answers its id, or null when it repeated what went up under two seconds ago. */
export function showToast(item: Omit<ToastItem, 'id'>): string | null {
  const { feed: next, id } = post(feed, { ...item, id: `toast-${++seq}` }, Date.now());
  if (id === null) return null;
  set(next);
  const shown = next.pinned.find((one) => one.id === id) ?? next.transient.find((one) => one.id === id);
  if (shown) {
    if (levelOf(shown) === 'attention') foldLater(shown.id);
    else startDwell(shown);
  }
  return id;
}

/** ×, a click through to its session, or Undo. */
export function closeToast(id: string): void {
  stopDwell(id);
  set(dismiss(feed, id));
}

/** A folded pinned pill clicked open; it folds again after six seconds. */
export function openToast(id: string): void {
  set(unfold(feed, id));
  foldLater(id);
}

/** The pointer resting on a toast keeps every passing toast; their dwells start over when it leaves. */
export function holdToasts(): void {
  held = true;
  for (const id of [...dwells.keys()]) stopDwell(id);
}

export function releaseToasts(): void {
  held = false;
  for (const toast of feed.transient) startDwell(toast);
}

/** Everything off the screen at once — sign-out, and between tests. */
export function clearToasts(): void {
  for (const id of [...dwells.keys()]) stopDwell(id);
  if (folding !== null) clearTimeout(folding);
  folding = null;
  held = false;
  set(EMPTY_FEED);
}
