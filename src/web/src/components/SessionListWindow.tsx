import { useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { measureElement, observeElementRect, useVirtualizer, type Range, type Virtualizer } from '@tanstack/react-virtual';

// The session column, windowed (docs/session-list-scale-design.md §4): whatever the column draws —
// the folder rows, the section heads, the session and project rows — is one list of items, and only
// the items in and near the viewport are mounted. Each item is measured as it is drawn, so rows of
// any height lay out as they did; the ones never drawn are placed at an estimate until they are.

/** A row's height before it is measured: one session row (`.session-row`'s min-height). */
const ROW_ESTIMATE = 64;

/** The rows drawn beyond the viewport each way: half the column's height in rows, so it mounts about two
 *  screens of rows in all wherever it is scrolled to. */
const overscanFor = (height: number): number => Math.max(3, Math.floor(height / ROW_ESTIMATE / 2));

/** What the column's owner asks of the window. */
export interface SessionListWindowHandle {
  /** Bring item `index` into view, by as little as it takes (nothing when it is in view already). */
  scrollToIndex: (index: number) => void;
  scrollToOffset: (offset: number) => void;
}

export interface SessionListWindowItem {
  /** The item's identity across renders, which keeps its measured height. */
  key: string;
}

export function SessionListWindow<T extends SessionListWindowItem>({
  handle,
  scrollRef,
  items,
  renderItem,
  keepMounted,
  hidden,
  onScrolled,
}: {
  handle: Ref<SessionListWindowHandle>;
  /** The column's scroll element, which this window draws into. */
  scrollRef: RefObject<HTMLDivElement | null>;
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
  /** Items that stay mounted wherever the column is scrolled: the first (the column's top block), a row
   *  being dragged (its drag ends on it), a row whose menu, swipe or Rename… field is open. */
  keepMounted: readonly number[];
  /** The column is not on screen (a phone showing a conversation): its height reads 0 then, which is no
   *  reason to draw every item; it keeps the rows it drew, at the heights they had, for when it comes back. */
  hidden: boolean;
  /** A scroll moved the window: the last item now in view, overscan aside. */
  onScrolled?: (lastVisibleIndex: number) => void;
}) {
  const scrolled = useRef(onScrolled);
  scrolled.current = onScrolled;
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  const lastHeight = useRef(0);
  const overscan = overscanFor(scrollRef.current?.clientHeight || lastHeight.current || (typeof window === 'undefined' ? 800 : window.innerHeight));
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?.key ?? index,
    overscan,
    // Told once the window has worked out what a scroll brought into view, which a listener on the column's
    // own scroll event would read before it had.
    onChange: (instance) => {
      if (instance.isScrolling && instance.range) scrolled.current?.(instance.range.endIndex);
    },
    // A scroll answered by a commit React schedules, not one forced inside the scroll event.
    useFlushSync: false,
    initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
    // A column that has no height has no layout to window by (a DOM without one, as in a test): every
    // item is drawn, as the column drew them before it was windowed. A hidden column keeps the height it
    // was last seen at, or a window's.
    observeElementRect: (instance, cb) => observeElementRect(instance, (rect) => {
      if (rect.height > 0) {
        lastHeight.current = rect.height;
        cb(rect);
      } else if (hiddenNow.current) {
        cb({ width: rect.width, height: lastHeight.current || window.innerHeight });
      } else {
        cb({ width: rect.width, height: Number.MAX_SAFE_INTEGER / 4 });
      }
    }),
    // An item inside a column that is not displayed measures nothing; it keeps the height it had.
    measureElement: (element, entry, instance) => {
      if (element.getClientRects().length === 0) {
        const index = instance.indexFromElement(element);
        return instance.measurementsCache[index]?.size ?? ROW_ESTIMATE;
      }
      return measureElement(element, entry, instance);
    },
    rangeExtractor: (range: Range) => {
      const shown = new Set<number>();
      for (let i = Math.max(0, range.startIndex - range.overscan); i <= Math.min(range.count - 1, range.endIndex + range.overscan); i += 1) shown.add(i);
      for (const index of keepMounted) if (index >= 0 && index < range.count) shown.add(index);
      return [...shown].sort((a, b) => a - b);
    },
  });
  // The scroll element is the column around this window, whose ref is attached after this window's own
  // layout effects ran: once it is, the window draws again and takes it up.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (virtualizer.scrollElement !== scrollRef.current) redraw();
  });
  const latest = useRef<Virtualizer<HTMLDivElement, HTMLDivElement>>(virtualizer);
  latest.current = virtualizer;
  useImperativeHandle(handle, () => ({
    scrollToIndex: (index) => latest.current.scrollToIndex(index, { align: 'auto' }),
    scrollToOffset: (offset) => latest.current.scrollToOffset(offset),
  }), []);
  // Back on screen, the column is where it was left: the browser forgets a hidden element's scroll.
  const savedOffset = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (hidden) return;
    if (savedOffset.current > 0 && el.scrollTop !== savedOffset.current) virtualizer.scrollToOffset(savedOffset.current);
    const keep = (): void => {
      if (el.clientHeight > 0) savedOffset.current = el.scrollTop;
    };
    el.addEventListener('scroll', keep, { passive: true });
    return () => el.removeEventListener('scroll', keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the virtualizer is one object for the window's life
  }, [hidden, scrollRef]);
  const drawn = virtualizer.getVirtualItems();
  return (
    <div className="session-list-window" style={{ height: virtualizer.getTotalSize() }}>
      {drawn.map((row) => {
        const item = items[row.index];
        if (!item) return null;
        return (
          <div
            key={row.key as string}
            className="session-list-item"
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderItem(item)}
          </div>
        );
      })}
    </div>
  );
}
