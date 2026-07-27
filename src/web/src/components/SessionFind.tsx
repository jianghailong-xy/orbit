import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseOutlined, DownOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import { findMatches, type FindSegment } from '../lib/findMatches';

/**
 * Find-in-session (⌘F / Ctrl+F): a browser-style find bar scoped to the open transcript.
 *
 * Highlighting goes through the CSS Custom Highlight API rather than wrapping matches in `<mark>`
 * elements. The transcript is React-rendered and streams while you read it; injecting nodes into
 * it would have React reconcile against a tree it doesn't own (and, at worst, throw removing a
 * child it can't find). Highlights are painted from Ranges, leaving the DOM untouched.
 */

// TypeScript's lib.dom only generates HighlightRegistry's `forEach`, not the maplike members the
// spec (and every implementation) actually has. Declared here rather than worked around with
// casts, in the same spirit as RunnerRegisterGuide's `declare const __PUBLIC_ORIGIN__`.
declare global {
  interface HighlightRegistry {
    set(name: string, highlight: Highlight): HighlightRegistry;
    delete(name: string): boolean;
  }
}

const HL_ALL = 'orbit-find';
const HL_CURRENT = 'orbit-find-current';

/** Without the Highlight API there is nothing to paint, so ⌘F is left to the browser instead of
 *  being swallowed by a find bar that can only count. */
export const FIND_SUPPORTED =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const FIND_HINT = IS_MAC ? '⌘F' : 'Ctrl F';

/** Opens the bar from a click elsewhere — the session menu's "Find in session", which is how it's
 *  reached without a keyboard. Same DOM-event idiom as the ⌘K palette's `openSessionSearch`. */
const OPEN_EVENT = 'orbit:open-session-find';
export const openSessionFind = (): void => {
  window.dispatchEvent(new Event(OPEN_EVENT));
};

const DEBOUNCE_MS = 120;
/** How many older pages one "search earlier" run may pull in before giving up — a bound on the
 *  requests a single ⇧↵ can fire against a session with tens of thousands of events. */
const MAX_EARLIER_PAGES = 10;
/** Keep the current match this far from the scroll container's edges. */
const SCROLL_MARGIN = 80;

/** Elements whose text is part of the surrounding sentence — a match may run straight through
 *  them. Anything else starts a new block (see FindSegment.block). */
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD', 'LABEL', 'MARK',
  'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
]);

/** Subtrees that hold no readable transcript text. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEXTAREA', 'INPUT', 'SELECT']);

interface Props {
  /** Resets the bar when the user switches sessions — the matches point at a DOM that's gone. */
  sessionId: string;
  /** The transcript's scroll container: both the search root and what we scroll to a match. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Pulls in the next older page; resolves true when events were actually prepended. */
  loadOlder: () => Promise<boolean>;
  /** Whether the server still holds older events than the ones loaded. */
  hasOlder: () => boolean;
}

export function SessionFind({ sessionId, containerRef, loadOlder, hasOlder }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const [searchingEarlier, setSearchingEarlier] = useState(false);
  // Mirrors of the above for the callbacks that run outside React's render cycle (key handlers,
  // the MutationObserver, the load-earlier loop), which must see the latest values.
  const matchesRef = useRef<Range[]>([]);
  const indexRef = useRef(0);
  const queryRef = useRef('');
  const openRef = useRef(false);
  const earlierRef = useRef(false);
  // Whether unsearched older events remain; refreshed on every scan so the count can say so.
  const [olderPending, setOlderPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The two callbacks the parent hands down, held in refs so every callback below can be stable.
  // AgentView re-renders on each streamed chunk; if these leaked into dependency arrays the
  // debounce effect would be torn down and restarted faster than its own timer could fire.
  const loadOlderRef = useRef(loadOlder);
  const hasOlderRef = useRef(hasOlder);
  useEffect(() => {
    loadOlderRef.current = loadOlder;
    hasOlderRef.current = hasOlder;
  });

  const paint = useCallback((ranges: Range[], idx: number) => {
    if (!FIND_SUPPORTED) return;
    if (!ranges.length) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
      return;
    }
    CSS.highlights.set(HL_ALL, new Highlight(...ranges));
    const cur = ranges[idx];
    if (!cur) {
      CSS.highlights.delete(HL_CURRENT);
      return;
    }
    const one = new Highlight(cur);
    one.priority = 1; // both highlights cover the current match; this one has to win
    CSS.highlights.set(HL_CURRENT, one);
  }, []);

  const setResult = useCallback(
    (ranges: Range[], idx: number) => {
      matchesRef.current = ranges;
      indexRef.current = idx;
      setMatches(ranges);
      setIndex(idx);
      paint(ranges, idx);
    },
    [paint],
  );

  /** Every match currently in the transcript's DOM, as Ranges in document order. */
  const scan = useCallback(
    (q: string): Range[] => {
      const root = containerRef.current;
      if (!root || !q) return [];
      const nodes: Text[] = [];
      const segments: FindSegment[] = [];
      const blocks = new Map<Element, number>();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          const el = node as Element;
          // REJECT prunes the whole subtree; SKIP keeps walking into it but emits no element.
          return SKIP.has(el.tagName) ||
            el.hasAttribute('hidden') ||
            el.getAttribute('aria-hidden') === 'true'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent) continue;
        let block: Element = parent;
        while (block !== root && INLINE.has(block.tagName) && block.parentElement) {
          block = block.parentElement;
        }
        let id = blocks.get(block);
        if (id === undefined) {
          id = blocks.size;
          blocks.set(block, id);
        }
        nodes.push(n as Text);
        segments.push({ text: n.nodeValue as string, block: id });
      }
      return findMatches(segments, q).map((m) => {
        const r = document.createRange();
        r.setStart(nodes[m.startSeg], m.startOffset);
        r.setEnd(nodes[m.endSeg], m.endOffset);
        return r;
      });
    },
    [containerRef],
  );

  const scrollTo = useCallback(
    (range: Range | undefined) => {
      const root = containerRef.current;
      if (!root || !range) return;
      const r = range.getBoundingClientRect();
      if (!r.height && !r.width) return; // collapsed (e.g. the node was replaced mid-stream)
      const c = root.getBoundingClientRect();
      if (r.top >= c.top + SCROLL_MARGIN && r.bottom <= c.bottom - SCROLL_MARGIN) return;
      root.scrollBy({ top: r.top - c.top - (c.height - r.height) / 2, behavior: 'smooth' });
    },
    [containerRef],
  );

  const goTo = useCallback(
    (idx: number) => {
      setResult(matchesRef.current, idx);
      scrollTo(matchesRef.current[idx]);
    },
    [scrollTo, setResult],
  );

  /**
   * Re-run the search over what's now in the DOM, holding the current match in place — the
   * transcript mutates constantly while a reply streams, and the highlight must not wander.
   * Identity, not index: an older page prepended above shifts every index down.
   */
  const refresh = useCallback((): Range[] => {
    const prev = matchesRef.current[indexRef.current];
    const next = scan(queryRef.current);
    const at = prev
      ? next.findIndex((r) => r.startContainer === prev.startContainer && r.startOffset === prev.startOffset)
      : -1;
    setResult(next, at >= 0 ? at : Math.min(indexRef.current, Math.max(0, next.length - 1)));
    setOlderPending(hasOlderRef.current());
    return next;
  }, [scan, setResult]);

  /** A fresh query starts from what the user is looking at, the way a browser's find does, rather
   *  than yanking them to the top of a long transcript. */
  const runQuery = useCallback(
    (q: string) => {
      const root = containerRef.current;
      const next = scan(q);
      let idx = 0;
      if (next.length && root) {
        const top = root.getBoundingClientRect().top;
        const below = next.findIndex((r) => r.getBoundingClientRect().bottom >= top);
        idx = below >= 0 ? below : next.length - 1;
      }
      setResult(next, idx);
      setOlderPending(hasOlderRef.current());
      scrollTo(next[idx]);
    },
    [containerRef, scan, scrollTo, setResult],
  );

  /**
   * Walk backwards into history: load older pages until one yields a match above the current one.
   * This is what ⇧↵ at the oldest match does, and what it does when nothing is loaded that
   * matches at all — so "not found" means "not in this session", not "not in the last 200 events".
   */
  const searchEarlier = useCallback(async () => {
    if (earlierRef.current || !hasOlderRef.current()) return;
    earlierRef.current = true;
    setSearchingEarlier(true);
    try {
      for (let i = 0; i < MAX_EARLIER_PAGES && openRef.current && hasOlderRef.current(); i++) {
        const prev = matchesRef.current[indexRef.current];
        if (!(await loadOlderRef.current())) break;
        // Let React commit the prepend (a task, then a frame) before reading the DOM back. If the
        // paint is late the loop simply pulls another page; the observer below fixes the count.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        if (!openRef.current) return;
        const next = refresh();
        if (!next.length) continue;
        const at = prev
          ? next.findIndex((r) => r.startContainer === prev.startContainer && r.startOffset === prev.startOffset)
          : -1;
        if (at > 0) return goTo(at - 1); // the nearest match in the newly loaded history
        if (at < 0) return goTo(next.length - 1); // nothing to anchor to: take the newest match
      }
      // Exhausted (or capped): wrap to the last match like a browser rather than dead-ending.
      if (matchesRef.current.length) goTo(matchesRef.current.length - 1);
    } finally {
      earlierRef.current = false;
      setSearchingEarlier(false);
    }
  }, [goTo, refresh]);

  const next = useCallback(() => {
    const n = matchesRef.current.length;
    if (n) goTo((indexRef.current + 1) % n);
  }, [goTo]);

  const prev = useCallback(() => {
    const n = matchesRef.current.length;
    if (n && indexRef.current > 0) goTo(indexRef.current - 1);
    else if (queryRef.current && hasOlderRef.current()) void searchEarlier();
    else if (n) goTo(n - 1);
  }, [goTo, searchEarlier]);

  const close = useCallback(() => setOpen(false), []);

  // ⌘F / Ctrl+F while a transcript is open. Bound on the window (not the transcript) so it works
  // from the composer too, and preventDefault'd to take the key from the browser's own find —
  // which would search the sidebar and header as readily as the conversation, and can't reach the
  // history that hasn't been loaded yet.
  useEffect(() => {
    if (!FIND_SUPPORTED) return;
    const onKey = (e: KeyboardEvent): void => {
      // Esc closes from wherever focus happens to be, not just from the input — the same trap the
      // ⌘K palette hit (3e8d888): a bar that stays put after Esc reads as stuck. Not
      // preventDefault'd, and only while open, so other Esc consumers keep working.
      if (e.key === 'Escape') {
        if (openRef.current) setOpen(false);
        return;
      }
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpen(true);
      // Already open: re-focus and select, so a second ⌘F retypes rather than appends.
      inputRef.current?.select();
    };
    const onOpen = (): void => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Switching sessions invalidates every match (they hold nodes from the old transcript).
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  // Closing drops the highlights; so does unmounting, since they live on the document, not here.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    setQuery('');
    setResult([], 0);
  }, [open, setResult]);

  useEffect(
    () => () => {
      if (!FIND_SUPPORTED) return;
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => runQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, query, runQuery]);

  // Keep the matches honest while the transcript changes underneath them — a streaming reply, a
  // prepended older page, a tool card the user expanded. Painting highlights mutates nothing, so
  // this can't feed itself.
  useEffect(() => {
    if (!open || !FIND_SUPPORTED) return;
    const root = containerRef.current;
    if (!root) return;
    let t: number | undefined;
    const obs = new MutationObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (queryRef.current && !earlierRef.current) refresh();
      }, 200);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      window.clearTimeout(t);
    };
  }, [containerRef, open, refresh]);

  if (!open) return null;

  const total = matches.length;
  // The trailing "+" is the honest part: the count covers what's loaded, and older events the
  // transcript hasn't pulled in yet may hold more (⇧↵ goes and gets them).
  const count = searchingEarlier
    ? 'Searching…'
    : query
      ? `${total ? index + 1 : 0}/${total}${olderPending ? '+' : ''}`
      : '';

  return (
    <div className="find-bar" role="search">
      <SearchOutlined className="find-bar-icon" />
      <input
        ref={inputRef}
        className="find-bar-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Let an IME keep Enter for picking a candidate — the whole feature is unusable in
          // Chinese otherwise.
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Find in session…"
        aria-label="Find in session"
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className={`find-bar-count${query && !total && !searchingEarlier ? ' find-bar-none' : ''}`}
        title={olderPending ? 'Earlier messages are not loaded yet — ⇧↵ searches them' : undefined}
      >
        {count}
      </span>
      <button type="button" className="find-bar-btn" onClick={prev} title="Previous match (⇧↵)">
        <UpOutlined />
      </button>
      <button type="button" className="find-bar-btn" onClick={next} title="Next match (↵)">
        <DownOutlined />
      </button>
      <button type="button" className="find-bar-btn" onClick={close} title="Close (Esc)">
        <CloseOutlined />
      </button>
    </div>
  );
}
