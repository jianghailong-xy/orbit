import { describe, expect, it } from 'vitest';
import { EMPTY_FEED, dismiss, dwellOf, expire, fold, levelOf, post, unfold, type ToastFeed, type ToastItem } from './toastFeed';

/** The toast system's rules (docs/mocks/toast-system, board ④) — the same cases as the native
 *  clients' ToastFeedTests, so both ports keep one behaviour. */

let seq = 0;
const toast = (over: Partial<ToastItem>): ToastItem => ({ id: `t${++seq}`, message: 'x', tone: 'success', ...over });
const T0 = 1_000_000;

function run(...steps: Array<[ToastItem, number]>): { feed: ToastFeed; ids: Array<string | null> } {
  let feed = EMPTY_FEED;
  const ids: Array<string | null> = [];
  for (const [item, at] of steps) {
    const next = post(feed, item, at);
    feed = next.feed;
    ids.push(next.id);
  }
  return { feed, ids };
}

describe('levels', () => {
  it('decides a toast’s level by what it asks of you', () => {
    expect(levelOf(toast({ message: 'Link copied' }))).toBe('confirm');
    expect(levelOf(toast({ message: 'Accepted', subtitle: 'Use pnpm' }))).toBe('confirm');
    expect(levelOf(toast({ message: 'Merged into main', sessionId: 's1' }))).toBe('confirm');
    expect(levelOf(toast({ message: 'Merging into main…', inProgress: true }))).toBe('progress');
    expect(levelOf(toast({ message: 'Session completed', action: { label: 'Undo', ariaLabel: 'Undo', onClick: () => {} } }))).toBe('result');
    expect(levelOf(toast({ message: 'Changes committed', detail: '1 file changed' }))).toBe('result');
    expect(levelOf(toast({ message: "Couldn't merge into main", tone: 'error' }))).toBe('attention');
    expect(levelOf(toast({ message: 'Waiting for your approval', tone: 'warning' }))).toBe('attention');
  });

  it('keeps only the ones that wait for you without a timer', () => {
    expect(dwellOf(toast({ message: 'Link copied' }))).toBe(3);
    expect(dwellOf(toast({ detail: 'why' }))).toBe(6);
    expect(dwellOf(toast({ tone: 'error' }))).toBeNull();
    expect(dwellOf(toast({ detail: 'why', duration: 10 }))).toBe(10);
    expect(dwellOf(toast({ tone: 'error', duration: 10 }))).toBeNull();
    expect(dwellOf(toast({ tone: 'warning', duration: 1 }))).toBeNull();
    expect(dwellOf(toast({ inProgress: true }))).toBe(60);
    expect(dwellOf(toast({ duration: 0 }))).toBeNull();
  });
});

describe('the slots', () => {
  it('never displaces a failure with what comes after it', () => {
    const { feed } = run(
      [toast({ message: "Couldn't merge into main", tone: 'error' }), T0],
      [toast({ message: 'Link copied' }), T0 + 1000],
    );
    expect(feed.pinned.map((one) => one.message)).toEqual(["Couldn't merge into main"]);
    expect(feed.transient.map((one) => one.message)).toEqual(['Link copied']);
  });

  it('opens the newest failure', () => {
    const { feed, ids } = run(
      [toast({ message: "Couldn't save the schedule", tone: 'error' }), T0],
      [toast({ message: "Couldn't merge into main", tone: 'error' }), T0 + 1000],
    );
    expect(feed.expanded).toBe(ids[1]);
    expect(feed.pinned).toHaveLength(2);
  });

  it('keeps the two newest passing toasts', () => {
    const { feed } = run(
      [toast({ message: 'a' }), T0],
      [toast({ message: 'b' }), T0 + 1],
      [toast({ message: 'c' }), T0 + 2],
    );
    expect(feed.transient.map((one) => one.message)).toEqual(['b', 'c']);
  });

  it('makes two quick taps on Copy one toast', () => {
    const { ids } = run(
      [toast({ message: 'Link copied' }), T0],
      [toast({ message: 'Link copied' }), T0 + 500],
      [toast({ message: 'Link copied' }), T0 + 3000],
    );
    expect(ids[1]).toBeNull();
    expect(ids[2]).not.toBeNull();
  });

  it('folds and unfolds a pinned card, and dismissing takes it away', () => {
    const { feed, ids } = run([toast({ message: "Couldn't merge into main", tone: 'error' }), T0]);
    const id = ids[0]!;
    const folded = fold(feed, id);
    expect(folded.expanded).toBeNull();
    expect(folded.pinned).toHaveLength(1);
    expect(unfold(folded, id).expanded).toBe(id);
    const gone = dismiss(feed, id);
    expect(gone.pinned).toEqual([]);
    expect(gone.expanded).toBeNull();
  });

  it('lets a dwell take down only a passing toast', () => {
    const { feed, ids } = run([toast({ message: "Couldn't merge into main", tone: 'error' }), T0]);
    expect(expire(feed, ids[0]!).pinned).toHaveLength(1);
  });
});

describe('one operation, one toast', () => {
  it('puts a result where its progress toast stood', () => {
    const { feed, ids } = run(
      [toast({ message: 'Merging into main…', key: 'merge:s1', inProgress: true }), T0],
      [toast({ message: 'Merged into main', key: 'merge:s1' }), T0 + 20_000],
    );
    expect(ids[1]).toBe(ids[0]);
    expect(feed.transient.map((one) => one.message)).toEqual(['Merged into main']);
  });

  it('turns a failed operation’s progress toast into a pinned card', () => {
    const { feed } = run(
      [toast({ message: 'Merging into main…', key: 'merge:s1', inProgress: true }), T0],
      [toast({ message: "Couldn't merge into main", tone: 'error', key: 'merge:s1' }), T0 + 20_000],
    );
    expect(feed.transient).toEqual([]);
    expect(feed.pinned.map((one) => one.message)).toEqual(["Couldn't merge into main"]);
    expect(feed.expanded).toBe(feed.pinned[0].id);
  });

  it('clears a failure once a retry of the same operation succeeds', () => {
    const { feed } = run(
      [toast({ message: "Couldn't merge into main", tone: 'error', key: 'merge:s1' }), T0],
      [toast({ message: 'Merged into main', key: 'merge:s1' }), T0 + 60_000],
    );
    expect(feed.pinned).toEqual([]);
    expect(feed.transient.map((one) => one.message)).toEqual(['Merged into main']);
  });

  it('updates the same failure’s card instead of pinning a second', () => {
    const { feed, ids } = run(
      [toast({ message: "Couldn't merge into main", detail: 'first', tone: 'error', key: 'merge:s1' }), T0],
      [toast({ message: "Couldn't merge into main", detail: 'second', tone: 'error', key: 'merge:s1' }), T0 + 30_000],
    );
    expect(ids[1]).toBe(ids[0]);
    expect(feed.pinned.map((one) => one.detail)).toEqual(['second']);
  });
});
